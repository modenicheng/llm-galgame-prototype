/**
 * CanonStore adapter（执行清单 M3.6 ①）——`games/<gameId>/world/canon.json` +
 * `world/canon.log.jsonl`（§9 布局常量 GAME_STORAGE_LAYOUT.worldCanon/Log）。
 *
 * 纪律与 OutlineStore 一致：损坏的 canon.json 大声抛错（canon 是跨周目世界
 * 真相，静默重建会吞掉裁决产出）；写走 tmp+rename 原子替换；修订日志
 * append-only，每行 `{revision, ops, reason, at}`，与全量文件同批生效
 * （applyPromotion 先写全量再追加日志）。
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  CanonCharacter,
  CanonOp,
  CanonSnapshot,
} from "../../core/ports/canon-store-port.js";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";

const CanonCharacterSchema: z.ZodType<CanonCharacter> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  spriteBinding: z.exactOptional(z.string().min(1)),
});

const CanonFileSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  worldSetting: z.string(),
  characters: z.array(CanonCharacterSchema),
  promotedFacts: z.array(
    z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      evidenceRuns: z.array(z.string().min(1)).min(1),
      judgedBy: z.string().min(1),
      promotedAt: z.string().min(1),
    }),
  ),
  exceptions: z.array(
    z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      reason: z.string().min(1),
      compensatingLimit: z.string().min(1),
    }),
  ),
});

const CanonOpSchema: z.ZodType<CanonOp> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("promote"),
    fact: z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      evidenceRuns: z.array(z.string().min(1)).min(1),
    }),
  }),
  z.object({
    type: z.literal("exception"),
    exception: z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      reason: z.string().min(1),
      compensatingLimit: z.string().min(1),
    }),
  }),
]);

interface CanonLogLine {
  revision: number;
  ops: CanonOp[];
  reason: string;
  at: string;
}

export class CanonStore {
  private readonly dir: string;
  private snapshot: CanonSnapshot;
  private loaded = false;

  constructor(private readonly gamesRoot: string, private readonly gameId: string) {
    this.dir = path.join(path.resolve(gamesRoot), gameId);
    this.snapshot = {
      revision: 0,
      worldSetting: "",
      characters: [],
      promotedFacts: [],
      exceptions: [],
    };
  }

  private get canonPath(): string {
    return path.join(this.dir, GAME_STORAGE_LAYOUT.worldCanon);
  }

  private get logPath(): string {
    return path.join(this.dir, GAME_STORAGE_LAYOUT.worldCanonLog);
  }

  /** 惰性加载；缺文件 = 空 canon（revision 0，兼容 M3.3 前的旧世界）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.canonPath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        this.loaded = true;
        return;
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw); // 损坏 JSON 大声抛错
    const checked = CanonFileSchema.parse(parsed); // 结构损坏大声抛错
    this.snapshot = checked;
    this.loaded = true;
  }

  getCanon(): CanonSnapshot {
    if (!this.loaded) {
      throw new Error("CanonStore.getCanon() called before load — await load() first");
    }
    return this.snapshot;
  }

  /** 显式加载（启动路径）。缺文件 = 空 canon；损坏抛错。 */
  async load(): Promise<CanonSnapshot> {
    await this.ensureLoaded();
    return this.snapshot;
  }

  /** 世界生成的脚手架：仅在 canon.json 不存在时合法（大声拒绝覆写）。 */
  async saveScaffold(world: {
    worldSetting: string;
    characters: CanonCharacter[];
  }): Promise<void> {
    let exists = false;
    try {
      await readFile(this.canonPath, "utf8");
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(`canon 脚手架拒绝写入：${this.canonPath} 已存在（不覆写既有 canon）`);
    }
    const next: CanonSnapshot = {
      revision: 0,
      worldSetting: world.worldSetting,
      characters: CanonCharacterSchema.array().parse(world.characters),
      promotedFacts: [],
      exceptions: [],
    };
    await mkdir(path.dirname(this.canonPath), { recursive: true });
    const tmpPath = `${this.canonPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
    await rename(tmpPath, this.canonPath);
    const logLine: CanonLogLine = {
      revision: 0,
      ops: [],
      reason: "世界生成脚手架（M3.3/M3.6）",
      at: new Date().toISOString(),
    };
    await appendFile(this.logPath, `${JSON.stringify(logLine)}\n`, "utf8");
    this.snapshot = next;
    this.loaded = true;
  }

  async applyPromotion(ops: CanonOp[], reason: string): Promise<number> {
    if (ops.length === 0) {
      throw new Error("canon applyPromotion 收到空批次");
    }
    await this.ensureLoaded();

    // 整批校验（工作副本上逐条应用，任何一条非法即整批拒绝，不落盘）。
    const next: CanonSnapshot = {
      ...this.snapshot,
      promotedFacts: [...this.snapshot.promotedFacts],
      exceptions: [...this.snapshot.exceptions],
    };
    for (const op of ops.map((o) => CanonOpSchema.parse(o))) {
      if (op.type === "promote") {
        if (
          next.promotedFacts.some((f) => f.id === op.fact.id) ||
          next.promotedFacts.some((f) => f.content === op.fact.content)
        ) {
          throw new Error(`canon op 非法：事实 ${op.fact.id} 已晋升（id/content 重复）`);
        }
        next.promotedFacts.push({
          id: op.fact.id,
          content: op.fact.content,
          evidenceRuns: [...op.fact.evidenceRuns],
          judgedBy: "canon-adjudicator",
          promotedAt: new Date().toISOString(),
        });
      } else {
        if (next.exceptions.some((e) => e.id === op.exception.id)) {
          throw new Error(`canon op 非法：例外 ${op.exception.id} 已登记`);
        }
        next.exceptions.push({ ...op.exception });
      }
    }
    next.revision = this.snapshot.revision + 1;

    // 落盘：先原子写全量，再追加日志（append-only 留痕，同批生效）。
    await mkdir(path.dirname(this.canonPath), { recursive: true });
    const tmpPath = `${this.canonPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
    await rename(tmpPath, this.canonPath);
    const logLine: CanonLogLine = {
      revision: next.revision,
      ops,
      reason,
      at: new Date().toISOString(),
    };
    await appendFile(this.logPath, `${JSON.stringify(logLine)}\n`, "utf8");

    this.snapshot = next;
    return next.revision;
  }
}
