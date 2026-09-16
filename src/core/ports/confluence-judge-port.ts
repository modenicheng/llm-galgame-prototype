/**
 * 汇流判定端口（执行清单 M2.1，设计 §3.3——**接口签名属冻结契约**）。
 *
 * 汇流不变量：一个决策节点的所有入边，末态都等于（≈）该节点的入口态。
 * 新边产生时先寻找匹配的既有后继节点——命中则连过去（汇流），未命中才
 * 新建；「分支汇流」因此被规约为一次边→节点匹配。本端口只承担其中的
 * **等价判定**：比较新边末态与候选后继入口态，回答「从此分叉继续，故事
 * 是否会一样？」。候选节点的枚举（如同场景过滤）是调用方的确定性职责，
 * 不进入本签名。
 *
 * 等价判定以 agent 主观判断为主（语义等价而非字段相等）；确定性比较器
 * （location/在场角色等精确键）是可插拔的可选加速组件——可实现为同一
 * 端口的另一个 adapter，或调用真判定前的前置过滤，摘除后不影响契约。
 *
 * 实时性红线：判定异步后台执行，绝不进入生成/播放同步路径（调用方义务）。
 */
import type { StateSnapshot } from "../graph/types.js";

/** 一次等价判定的结论（调用方据此组装边上的 ConfluenceEvidence 凭据）。 */
export interface ConfluenceJudgment {
  /** 双方状态是否语义等价（≈，§3.3）——等价即可连向候选后继节点。 */
  equivalent: boolean;
  /** 判定置信度 [0, 1]；低置信是否落边由调用方策略决定（M2.2）。 */
  confidence: number;
  /** 判定依据（差异审计的凭据正文，落盘进 evidence.rationale）。 */
  rationale: string;
  /** 判定者标识（如 `llm:<model>`；确定性比较器报自己的键集），落盘进 evidence.judgedBy。 */
  judgedBy: string;
}

export interface ConfluenceJudgePort {
  judge(input: {
    /** 新边的真实末态（汇流比较对象，§3.2）。 */
    endState: StateSnapshot;
    /** 候选后继决策节点的入口态（同一种货币）。 */
    candidateEntry: StateSnapshot;
  }): Promise<ConfluenceJudgment>;
}
