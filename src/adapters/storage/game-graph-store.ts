/**
 * Node.js 剧情图存储（设计 §9 布局，执行清单 M1.2）。
 *
 * 文件布局由 `GAME_STORAGE_LAYOUT` 冻结；本类只做三件事：JSONL 追加与
 * latest-wins 读取、快照/游标的原子单文件读写、边 endState 的派生与一致
 * 性校验。损坏的 JSONL 行跳过（不掩盖后续行）；结构级损坏（索引行存在
 * 而快照缺失）大声抛错——那是恢复路径的真源，静默降级等于丢档。
 */
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isStoredEvent } from "./stored-event.js";
import type { StoredEvent } from "../../schema.js";
import type { CharacterRoster } from "../../core/characters/types.js";
import type { GraphIdentityContext } from "../../core/ports/identity-snapshot-port.js";
import type {
  ActiveCursor,
  DecisionNode,
  EndingNode,
  PlotEdge,
  RunRecord,
  SceneNode,
  StateSnapshot,
} from "../../core/graph/types.js";
import {
  ActiveCursorSchema,
  ConfluenceEvidenceSchema,
  DecisionNodeSchema,
  EdgeEndpointSchema,
  EdgePayloadStatsSchema,
  EndingNodeSchema,
  InteractionFormSnapshotSchema,
  PlotEdgeSchema,
  RunRecordSchema,
  SceneNodeSchema,
  SNAPSHOT_VERSION,
  StateSnapshotSchema,
} from "../../core/graph/types.js";
import {
  assertSupportedSnapshotVersion,
  readSnapshotVersion,
  upcastSnapshotV3ToV4,
} from "../../core/graph/snapshot-upcast.js";
import {
  DecisionIdSchema,
  EdgeIdSchema,
} from "../../core/graph/ids.js";
import {
  GAME_STORAGE_LAYOUT,
  GameIdSchema,
  decisionSnapshotPath,
  edgePayloadPath,
  rosterBlobPath,
  type DecisionId,
  type EdgeId,
  type RunId,
} from "../../core/graph/ids.js";
import { CharacterRosterSchema } from "../../core/characters/types.js";
import type { GraphStorePort } from "../../core/ports/graph-store-port.js";

// ---------------------------------------------------------------------------
// 磁盘记录 schema（索引行 ≠ 契约记录：entryState/endState 的真源拆分见端口头注）
// ---------------------------------------------------------------------------

const DecisionRecordSchema = z.object({
  id: DecisionNodeSchema.shape.id,
  sceneId: DecisionNodeSchema.shape.sceneId,
  form: InteractionFormSnapshotSchema,
});

const EdgeRecordSchema = z
  .object({
    id: EdgeIdSchema,
    from: DecisionIdSchema,
    choice: z.object({
      kind: z.enum(["option", "free_input"]),
      text: z.string().min(1),
    }),
    payload: EdgePayloadStatsSchema,
    to: EdgeEndpointSchema,
    /**
     * 内联 ⟺ 结局端点（无快照归宿）或汇流边（真实末态与后继入口 ≈ 不等，
     * §3.3；凭据承担差异）。普通决策端点由后继入口快照派生、不落盘。
     * 载荷以 unknown 透传：旧世界的内联末态是 v3 形状，统一在 composeEdge
     * 走版本闸门 + 升级适配（此处过 v4 schema 会把旧行当损坏行静默丢弃）。
     */
    endState: z.exactOptional(z.unknown()),
    confluence: z.exactOptional(ConfluenceEvidenceSchema),
  })
  .refine(
    (record) =>
      (record.to.kind === "ending" || record.confluence !== undefined) ===
      (record.endState !== undefined),
    { message: "inline endState is required exactly for ending endpoints and confluence edges" },
  );

type EdgeRecord = z.infer<typeof EdgeRecordSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 键序无关的 JSON 比较（zod exactOptional 字段 absent/undefined 等价）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`)
    .join(",")}}`;
}

async function readJsonlLines(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 解析 JSONL 行，损坏行跳过。M5.6 tombstone：`{"id":"…","deleted":true}`
 * 行删除同 id 的此前记录——磁盘 append-only 不回改，读取端折叠过滤（§3
 * 契约 schema 不动）。输出 = 折叠后的存活记录，按**首次出现序**；需要
 * 「最近写入序」的调用方（listRuns）改用 parseJsonlWriteOrder。 */
async function parseJsonl<T extends { id: string }>(filePath: string, schema: z.ZodType<T>): Promise<T[]> {
  return (await parseJsonlWriteOrder(filePath, schema)).records;
}

/** 同 parseJsonl，但 records 按**最近写入序**排列（末位 = 最后写入的记录）。 */
async function parseJsonlWriteOrder<T extends { id: string }>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<{ records: T[] }> {
  const latest = new Map<string, { deleted: boolean; record?: T }>();
  const lastWriteIdx = new Map<string, number>();
  let writeIndex = 0;
  for (const line of await readJsonlLines(filePath)) {
    writeIndex += 1;
    try {
      const parsed: unknown = JSON.parse(line);
      let id: string | undefined;
      let deleted = false;
      let record: T | undefined;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { deleted?: unknown }).deleted === true &&
        typeof (parsed as { id?: unknown }).id === "string"
      ) {
        id = (parsed as { id: string }).id;
        deleted = true;
      } else {
        const result = schema.safeParse(parsed);
        if (!result.success) continue;
        id = result.data.id;
        record = result.data;
      }
      if (deleted) {
        latest.set(id, { deleted });
      } else if (record !== undefined) {
        latest.set(id, { deleted, record });
      }
      lastWriteIdx.set(id, writeIndex);
    } catch {
      // 一行损坏不得掩盖 append-only 日志的其余部分。
    }
  }
  const records = [...latest.values()]
    .filter((entry) => !entry.deleted && entry.record !== undefined)
    .map((entry) => entry.record!);
  // 按各 id 的最后写入位排序（末位 = 最近写入；Map 序是首次出现序，不同）。
  records.sort(
    (a, b) => (lastWriteIdx.get(a.id) ?? 0) - (lastWriteIdx.get(b.id) ?? 0),
  );
  return { records };
}

/** latest-wins：同 id 多行时取最后一次出现。 */
function latestById<T extends { id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export class GameGraphStore implements GraphStorePort {
  readonly location: string;
  /**
   * M3 身份上下文（可选装配）：
   * - 读取：v3 快照经显式适配器升级为 v4（身份映射解析在图水合前完成）；
   *   未装配时 v3 读取显式报错（不静默按某套身份猜读）。
   * - 写入：快照引用的 roster revision 首次出现时落共享不可变 blob。
   */
  private readonly identity: GraphIdentityContext | undefined;
  /** 已确认落盘的 roster revision（幂等跳过）。 */
  private readonly rosterBlobRevisions = new Set<string>();

  constructor(
    gamesRoot: string,
    gameId: string,
    options?: { identity?: GraphIdentityContext },
  ) {
    if (!GameIdSchema.safeParse(gameId).success) {
      throw new Error(`非法 gameId：${gameId}`);
    }
    this.location = path.resolve(gamesRoot, gameId);
    this.identity = options?.identity;
  }

  private filePath(relPath: string): string {
    return path.join(this.location, ...relPath.split("/"));
  }

  private async appendRecord(relPath: string, record: unknown): Promise<void> {
    await appendFile(this.filePath(relPath), `${JSON.stringify(record)}\n`, "utf8");
  }

  async initialize(): Promise<void> {
    await mkdir(this.filePath(GAME_STORAGE_LAYOUT.payloadsDir), { recursive: true });
    await mkdir(this.filePath(GAME_STORAGE_LAYOUT.snapshotsDir), { recursive: true });
    await mkdir(this.filePath(GAME_STORAGE_LAYOUT.rostersDir), { recursive: true });
  }

  // -- roster blobs（M3：共享不可变，按 revision 一份） --------------------------

  async putRosterBlob(roster: CharacterRoster): Promise<void> {
    const parsed = CharacterRosterSchema.parse(roster);
    if (this.rosterBlobRevisions.has(parsed.revision)) return;
    const blobPath = this.filePath(rosterBlobPath(parsed.revision));
    if (await fileExists(blobPath)) {
      // 不可变 blob：revision 相同即内容相同（revision 是规范化定义的摘要）。
      // 已存在不覆写——append-only 纪律在 roster 维度的对应物。
      this.rosterBlobRevisions.add(parsed.revision);
      return;
    }
    const tmpPath = `${blobPath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(blobPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(parsed), "utf8");
    await rename(tmpPath, blobPath);
    this.rosterBlobRevisions.add(parsed.revision);
  }

  async getRosterBlob(revision: string): Promise<CharacterRoster | null> {
    const blobPath = this.filePath(rosterBlobPath(revision));
    let raw: string;
    try {
      raw = await readFile(blobPath, "utf8");
    } catch {
      return null;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `roster blob 损坏（${blobPath}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return CharacterRosterSchema.parse(payload);
  }

  /** 写快照后确保其引用的 roster blob 存在（有当前 roster 且 revision 对得上）。 */
  private async ensureRosterBlobOf(snapshot: StateSnapshot): Promise<void> {
    if (this.identity === undefined) return;
    const roster = this.identity.roster();
    if (roster === undefined || roster.revision !== snapshot.identity.rosterRevision) {
      return; // legacy 会话或历史 revision：blob 由写入当时的进程负责
    }
    await this.putRosterBlob(roster);
  }

  // -- scenes / endings / runs ------------------------------------------------

  async putScene(scene: SceneNode): Promise<void> {
    SceneNodeSchema.parse(scene);
    await this.appendRecord(GAME_STORAGE_LAYOUT.scenes, scene);
  }

  async listScenes(): Promise<SceneNode[]> {
    return [
      ...latestById(
        await parseJsonl(this.filePath(GAME_STORAGE_LAYOUT.scenes), SceneNodeSchema),
      ).values(),
    ];
  }

  /** M5.6：tombstone 决策记录（append-only 删除标记行，磁盘不回改）。 */
  async removeDecision(id: DecisionId): Promise<void> {
    await this.appendRecord(GAME_STORAGE_LAYOUT.decisions, { id, deleted: true });
  }

  /** M5.6：tombstone 边记录；其负载文件随后成为孤儿（GC 一并清理）。 */
  async removeEdge(id: EdgeId): Promise<void> {
    await this.appendRecord(GAME_STORAGE_LAYOUT.edges, { id, deleted: true });
    await this.deletePayload(id);
  }

  async putEnding(ending: EndingNode): Promise<void> {
    EndingNodeSchema.parse(ending);
    await this.appendRecord(GAME_STORAGE_LAYOUT.endings, ending);
  }

  async putRun(run: RunRecord): Promise<void> {
    RunRecordSchema.parse(run);
    await this.appendRecord(GAME_STORAGE_LAYOUT.runs, run);
  }

  async getRun(id: RunId): Promise<RunRecord | null> {
    const run = latestById(
      await parseJsonl(this.filePath(GAME_STORAGE_LAYOUT.runs), RunRecordSchema),
    ).get(id);
    return run ?? null;
  }

  async listRuns(): Promise<RunRecord[]> {
    // latest-wins 折叠，按最近写入序排列：末位 = 最近活动的周目（弃局/结局
    // 更新会再追加一行，折叠后每个周目恰一条记录、位置 = 其最后写入位）。
    return (await parseJsonlWriteOrder(this.filePath(GAME_STORAGE_LAYOUT.runs), RunRecordSchema)).records;
  }

  // -- decisions ----------------------------------------------------------------

  async putDecision(node: DecisionNode): Promise<void> {
    const parsed = DecisionNodeSchema.parse(node);
    // 先写快照再写索引行：索引行存在而快照缺失是结构损坏（读取时抛错），
    // 反向的孤儿快照无害。
    await this.writeSnapshot(parsed.id, parsed.entryState);
    await this.appendRecord(GAME_STORAGE_LAYOUT.decisions, {
      id: parsed.id,
      sceneId: parsed.sceneId,
      form: parsed.form,
    });
  }

  private async writeSnapshot(decisionId: DecisionId, snapshot: StateSnapshot): Promise<void> {
    const snapshotPath = this.filePath(decisionSnapshotPath(decisionId));
    const tmpPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(snapshot), "utf8");
    await rename(tmpPath, snapshotPath);
    await this.ensureRosterBlobOf(snapshot);
  }

  /**
   * 快照载荷解析（文件快照与边内联末态共用）：v4 直接过契约 schema；v3
   * 走显式升级适配器（需要身份上下文——世界 registry 与身份映射在图水合
   * 前解析）；v1/v2 与未来版本按版本闸门显式拒绝，不静默误读。原文件字节
   * 不动（升级只在内存副本上完成）。
   */
  private normalizeSnapshotPayload(payload: unknown, where: string): StateSnapshot {
    const version = readSnapshotVersion(payload);
    if (version === undefined) {
      // 无版本字段 = 结构损坏，交给契约 schema 报详情（大声失败语义不变）。
      return StateSnapshotSchema.parse(payload);
    }
    assertSupportedSnapshotVersion(version);
    if (version === SNAPSHOT_VERSION) {
      return StateSnapshotSchema.parse(payload);
    }
    // v3：显式升级。无身份上下文 = 无法诚实解析身份引用，明确报错。
    if (this.identity === undefined) {
      throw new Error(
        `${where} 为 v3（旧身份格式），但本 store 未装配身份上下文` +
          "（GraphIdentityContext）——无法完成 v3→v4 身份升级，拒绝猜读",
      );
    }
    const roster = this.identity.roster();
    if (roster === undefined) {
      throw new Error(
        `${where} 为 v3（旧身份格式），但当前世界没有 roster` +
          "（legacy 兼容世界）——无法完成 v3→v4 身份升级，拒绝猜读",
      );
    }
    return upcastSnapshotV3ToV4(payload, {
      roster: {
        scopeId: roster.scopeId,
        revision: roster.revision,
        playerId: roster.playerId,
        characters: roster.characters,
      },
      dslProtocolVersion: this.identity.dslProtocolVersion(),
      ...(this.identity.legacyMapping !== undefined
        ? { legacyMapping: this.identity.legacyMapping }
        : {}),
    });
  }

  private async readSnapshot(decisionId: DecisionId): Promise<StateSnapshot> {
    const snapshotPath = this.filePath(decisionSnapshotPath(decisionId));
    let raw: string;
    try {
      raw = await readFile(snapshotPath, "utf8");
    } catch {
      throw new Error(`决策节点快照缺失（结构损坏）：${snapshotPath}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `决策节点快照损坏（JSON 解析失败）：${snapshotPath}——${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.normalizeSnapshotPayload(payload, `决策节点快照 ${snapshotPath}`);
  }

  private async composeDecision(
    record: z.infer<typeof DecisionRecordSchema>,
  ): Promise<DecisionNode> {
    return {
      id: record.id,
      sceneId: record.sceneId,
      entryState: await this.readSnapshot(record.id),
      form: record.form,
    };
  }

  async getDecision(id: DecisionId): Promise<DecisionNode | null> {
    const record = latestById(
      await parseJsonl(this.filePath(GAME_STORAGE_LAYOUT.decisions), DecisionRecordSchema),
    ).get(id);
    return record === undefined ? null : await this.composeDecision(record);
  }

  async listDecisions(): Promise<DecisionNode[]> {
    const records = latestById(
      await parseJsonl(this.filePath(GAME_STORAGE_LAYOUT.decisions), DecisionRecordSchema),
    );
    const nodes: DecisionNode[] = [];
    for (const record of records.values()) {
      nodes.push(await this.composeDecision(record));
    }
    return nodes;
  }

  // -- edges ----------------------------------------------------------------

  async putEdge(edge: PlotEdge): Promise<void> {
    const parsed = PlotEdgeSchema.parse(edge);
    const base = {
      id: parsed.id,
      from: parsed.from,
      choice: parsed.choice,
      payload: parsed.payload,
      to: parsed.to,
    };
    let record: EdgeRecord;
    if (parsed.to.kind === "ending" || parsed.confluence !== undefined) {
      // 结局端点与汇流边：真实末态内联。汇流边末态按定义只与后继入口
      // ≈ 相等（§3.3），凭据（judgedBy/confidence/rationale）承担差异。
      record = {
        ...base,
        endState: parsed.endState,
        ...(parsed.confluence === undefined ? {} : { confluence: parsed.confluence }),
      };
    } else {
      // 普通决策端点：endState 由后继入口快照派生，落盘前校验一致（§3.3
      // 不变量的写入门禁——不一致即 Game 侧 bug，大声拒绝）。
      const successorEntry = await this.readSnapshot(parsed.to.id);
      if (stableStringify(successorEntry) !== stableStringify(parsed.endState)) {
        throw new Error(
          `边 ${parsed.id} 的 endState 与后继节点 ${parsed.to.id} 的入口快照不一致`,
        );
      }
      record = base;
    }
    await this.appendRecord(GAME_STORAGE_LAYOUT.edges, record);
  }

  private async composeEdge(record: EdgeRecord): Promise<PlotEdge> {
    // 内联真实末态（结局端点/汇流边）优先——旧世界的内联末态是 v3 形状，
    // 与文件快照同一版本闸门/升级适配；普通决策端点从后继入口派生。
    const endState =
      record.endState !== undefined
        ? this.normalizeSnapshotPayload(record.endState, `边 ${record.id} 的内联末态`)
        : await this.readSnapshot(record.to.id);
    return {
      id: record.id,
      from: record.from,
      choice: record.choice,
      payload: record.payload,
      endState,
      to: record.to,
      ...(record.confluence === undefined ? {} : { confluence: record.confluence }),
    };
  }

  async listEdges(): Promise<PlotEdge[]> {
    const records = latestById(
      await parseJsonl(this.filePath(GAME_STORAGE_LAYOUT.edges), EdgeRecordSchema),
    );
    const edges: PlotEdge[] = [];
    for (const record of records.values()) {
      edges.push(await this.composeEdge(record));
    }
    return edges;
  }

  // -- payloads（回放数据） -----------------------------------------------------

  async appendPayload(edgeId: EdgeId, event: StoredEvent): Promise<void> {
    await appendFile(
      this.filePath(edgePayloadPath(edgeId)),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }

  async readPayload(edgeId: EdgeId): Promise<StoredEvent[]> {
    const events: StoredEvent[] = [];
    for (const line of await readJsonlLines(this.filePath(edgePayloadPath(edgeId)))) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isStoredEvent(parsed)) events.push(parsed);
      } catch {
        // 跳过损坏行。
      }
    }
    return events;
  }

  async listPayloadIds(): Promise<EdgeId[]> {
    let entries: string[];
    try {
      entries = await readdir(this.filePath(GAME_STORAGE_LAYOUT.payloadsDir));
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length) as EdgeId);
  }

  async deletePayload(edgeId: EdgeId): Promise<void> {
    await rm(this.filePath(edgePayloadPath(edgeId)), { force: true });
  }

  // -- cursor ----------------------------------------------------------------

  async saveCursor(cursor: ActiveCursor): Promise<void> {
    const cursorPath = this.filePath(GAME_STORAGE_LAYOUT.cursor);
    const tmpPath = `${cursorPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(cursor), "utf8");
    await rename(tmpPath, cursorPath);
  }

  async clearCursor(): Promise<void> {
    await rm(this.filePath(GAME_STORAGE_LAYOUT.cursor), { force: true });
  }

  async loadCursor(): Promise<ActiveCursor | null> {
    const cursorPath = this.filePath(GAME_STORAGE_LAYOUT.cursor);
    let raw: string;
    try {
      raw = await readFile(cursorPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined; // 无法解析 → 走下方统一的损坏处理
    }
    const result = ActiveCursorSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`[graph-store] 游标文件损坏，按无活动周目处理：${cursorPath}`);
      return null;
    }
    return result.data;
  }
}
