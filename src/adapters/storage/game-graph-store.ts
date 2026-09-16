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
  StateSnapshotSchema,
} from "../../core/graph/types.js";
import {
  DecisionIdSchema,
  EdgeIdSchema,
} from "../../core/graph/ids.js";
import {
  GAME_STORAGE_LAYOUT,
  GameIdSchema,
  decisionSnapshotPath,
  edgePayloadPath,
  type DecisionId,
  type EdgeId,
  type RunId,
} from "../../core/graph/ids.js";
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
     */
    endState: z.exactOptional(StateSnapshotSchema),
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

/** 解析 JSONL 行，损坏行跳过；返回按文件序的合法记录。 */
async function parseJsonl<T>(filePath: string, schema: z.ZodType<T>): Promise<T[]> {
  const records: T[] = [];
  for (const line of await readJsonlLines(filePath)) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = schema.safeParse(parsed);
      if (result.success) records.push(result.data);
    } catch {
      // 一行损坏不得掩盖 append-only 日志的其余部分。
    }
  }
  return records;
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

  constructor(gamesRoot: string, gameId: string) {
    if (!GameIdSchema.safeParse(gameId).success) {
      throw new Error(`非法 gameId：${gameId}`);
    }
    this.location = path.resolve(gamesRoot, gameId);
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
    // latest-wins 折叠，按各周目最后一次写入排序：末位 = 最近活动的周目
    // （弃局/结局更新会再追加一行，折叠后每个周目恰一条记录）。
    const records = await parseJsonl(this.filePath(GAME_STORAGE_LAYOUT.runs), RunRecordSchema);
    const lastIdx = new Map<string, number>();
    records.forEach((record, index) => lastIdx.set(record.id, index));
    return [...latestById(records).values()].sort(
      (a, b) => (lastIdx.get(a.id) ?? 0) - (lastIdx.get(b.id) ?? 0),
    );
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
  }

  private async readSnapshot(decisionId: DecisionId): Promise<StateSnapshot> {
    const snapshotPath = this.filePath(decisionSnapshotPath(decisionId));
    let raw: string;
    try {
      raw = await readFile(snapshotPath, "utf8");
    } catch {
      throw new Error(`决策节点快照缺失（结构损坏）：${snapshotPath}`);
    }
    return StateSnapshotSchema.parse(JSON.parse(raw));
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
    // 内联真实末态（结局端点/汇流边）优先；普通决策端点从后继入口派生。
    const endState =
      record.endState !== undefined ? record.endState : await this.readSnapshot(record.to.id);
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
