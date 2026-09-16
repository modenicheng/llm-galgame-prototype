/**
 * OutlineStore adapter（执行清单 M3.1）——`games/<gameId>/outline.json` +
 * `outline.log.jsonl`（§9 布局常量 GAME_STORAGE_LAYOUT.outline/outlineLog）。
 *
 * 真源纪律与快照一致（M1.2）：损坏的 outline.json 大声抛错（不降级——
 * 大纲是结构真源，静默重建会吞掉作者/维护产出）；写走 tmp+rename 原子替换；
 * 修订日志 append-only，每行 `{revision, ops, reason, at}`，与全量文件
 * 一致（applyRevision 先写全量再追加日志，两步同批生效）。
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OutlineStorePort, type OutlineOp, type OutlineSnapshot } from "../../core/ports/outline-store-port.js";
import {
  OutlineNodeSchema,
  transitionOutlineNode,
} from "../../core/outline/types.js";
import type { OutlineNode } from "../../core/outline/types.js";
import { GAME_STORAGE_LAYOUT } from "../../core/graph/ids.js";

const OutlineFileSchema = z.object({
  revision: z.number().int().nonnegative(),
  nodes: z.array(OutlineNodeSchema),
});

interface OutlineLogLine {
  revision: number;
  ops: OutlineOp[];
  reason: string;
  at: string;
}

export class OutlineStore implements OutlineStorePort {
  private readonly dir: string;
  private nodes: OutlineNode[];
  private revision: number;
  private loaded = false;

  constructor(private readonly gamesRoot: string, private readonly gameId: string) {
    this.dir = path.join(path.resolve(gamesRoot), gameId);
    this.nodes = [];
    this.revision = 0;
  }

  private get outlinePath(): string {
    return path.join(this.dir, GAME_STORAGE_LAYOUT.outline);
  }

  private get logPath(): string {
    return path.join(this.dir, GAME_STORAGE_LAYOUT.outlineLog);
  }

  /** 惰性加载；调用方任何读/写前都会触发。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.outlinePath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // 尚无大纲（M3.3 之前的旧世界 / 未生成）：空大纲 revision 0。
        this.loaded = true;
        return;
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw); // 损坏 JSON 大声抛错
    const checked = OutlineFileSchema.parse(parsed); // 结构损坏大声抛错
    this.nodes = checked.nodes;
    this.revision = checked.revision;
    this.loaded = true;
  }

  getOutline(): OutlineSnapshot {
    if (!this.loaded) {
      throw new Error("OutlineStore.getOutline() called before load — await applyRevision() or call load() first");
    }
    return { nodes: this.nodes, revision: this.revision };
  }

  /** 显式加载（启动路径）。缺文件 = 空大纲；损坏抛错。 */
  async load(): Promise<OutlineSnapshot> {
    await this.ensureLoaded();
    return { nodes: this.nodes, revision: this.revision };
  }

  async applyRevision(ops: OutlineOp[], reason: string): Promise<number> {
    if (ops.length === 0) {
      throw new Error("outline applyRevision 收到空批次");
    }
    await this.ensureLoaded();

    // 整批校验（工作副本上逐条迁移，任何一条非法即整批拒绝）。
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    for (const op of ops) {
      if (op.type === "add") {
        const checked = OutlineNodeSchema.parse(op.node);
        if (byId.has(checked.id)) {
          throw new Error(`outline op 非法：节点 ${checked.id} 已存在（add）`);
        }
        if (checked.status !== "planned") {
          throw new Error(`outline op 非法：add 只接受 planned 节点（${checked.id}=${checked.status}，决议 D5）`);
        }
        byId.set(checked.id, checked);
        continue;
      }
      const current = byId.get(op.id);
      if (current === undefined) {
        throw new Error(`outline op 非法：节点 ${op.id} 不存在（${op.type}）`);
      }
      if (op.type === "activate") {
        const next = transitionOutlineNode(current, "active");
        if (next === undefined) {
          throw new Error(`outline op 非法：${current.id} 不能 ${current.status} → active`);
        }
        byId.set(op.id, next);
      } else if (op.type === "realize") {
        const next = transitionOutlineNode(current, "realized", op.instantiatedBy);
        if (next === undefined) {
          throw new Error(`outline op 非法：${current.id} 不能 ${current.status} → realized`);
        }
        byId.set(op.id, next);
      } else {
        const next = transitionOutlineNode(current, "pruned");
        if (next === undefined) {
          throw new Error(`outline op 非法：${current.id} 不能 ${current.status} → pruned`);
        }
        byId.set(op.id, next);
      }
    }

    const nextNodes = [...byId.values()];
    const nextRevision = this.revision + 1;

    // 落盘：先原子写全量，再追加日志（同批生效）。
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.outlinePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(
      tmpPath,
      JSON.stringify({ revision: nextRevision, nodes: nextNodes }),
      "utf8",
    );
    await rename(tmpPath, this.outlinePath);
    const logLine: OutlineLogLine = {
      revision: nextRevision,
      ops,
      reason,
      at: new Date().toISOString(),
    };
    await appendFile(this.logPath, `${JSON.stringify(logLine)}\n`, "utf8");

    this.nodes = nextNodes;
    this.revision = nextRevision;
    return nextRevision;
  }
}
