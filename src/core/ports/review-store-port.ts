/**
 * ReviewStore port（执行清单 M5.5 ①）——通关评分存档
 * `games/<gameId>/reviews/<runId>.json`（每完结周目一份）。
 */

/** 单次通关评分（玩家星级 + 编剧评注）。 */
export interface RunReview {
  runId: string;
  /** 玩家星级 1–5。 */
  rating: number;
  /** 编剧评注（单次 LLM 调用产出）。 */
  comment: string;
  /** 大纲贴合度（编剧自评：评注与既定大纲的吻合描述）。 */
  outlineFit: string;
  reviewedAt: string;
}

export interface ReviewStorePort {
  save(review: RunReview): Promise<void>;
  load(runId: string): Promise<RunReview | null>;
  list(): Promise<RunReview[]>;
}
