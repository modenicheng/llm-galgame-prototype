/**
 * ReviewStore adapter（执行清单 M5.5 ①）——`games/<gameId>/reviews/` 目录
 * 下每完结周目一份 `<runId>.json`（tmp+rename 原子写；损坏大声抛错）。
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ReviewStorePort, RunReview } from "../../core/ports/review-store-port.js";

const ReviewFileSchema = z.object({
  runId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(1),
  outlineFit: z.string().min(1),
  reviewedAt: z.string().min(1),
});

export class ReviewStore implements ReviewStorePort {
  private readonly dir: string;

  constructor(private readonly gamesRoot: string, private readonly gameId: string) {
    this.dir = path.join(path.resolve(gamesRoot), gameId, "reviews");
  }

  private reviewPath(runId: string): string {
    // runId 形如 run_<suffix>；去前缀防目录穿越并保持文件名稳定。
    const safe = runId.replace(/^run_/, "").replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  async save(review: RunReview): Promise<void> {
    const checked = ReviewFileSchema.parse(review);
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.reviewPath(checked.runId)}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(checked, null, 2), "utf8");
    await rename(tmpPath, this.reviewPath(checked.runId));
  }

  async load(runId: string): Promise<RunReview | null> {
    try {
      return ReviewFileSchema.parse(JSON.parse(await readFile(this.reviewPath(runId), "utf8")));
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  }

  async list(): Promise<RunReview[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const reviews: RunReview[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      reviews.push(ReviewFileSchema.parse(JSON.parse(await readFile(path.join(this.dir, file), "utf8"))));
    }
    return reviews.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
  }
}
