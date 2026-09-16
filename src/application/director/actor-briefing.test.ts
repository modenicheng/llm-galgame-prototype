/**
 * ActorBriefing 防火墙测试（执行清单 M4.2 验收）：
 * - 结构性防火墙：输入类型不含 outline 全量/结局候选/他周目数据；
 * - 生成请求 user prompt 的负面断言（未实现 outline purpose / 结局候选
 *   文本不出现在 prompt 中）；
 * - 有 directive 时含防守/收束段；无 directive 时与现行为等价。
 */

import { describe, it, expect } from "vitest";
import { buildActorBriefing } from "./actor-briefing.js";
import { buildDslUserPrompt } from "../../story/context-builder.js";
import { createInitialState } from "../../story/state.js";
import type { DslContextInput } from "../../story/context-builder.js";
import type { StoryState } from "../../story/types.js";

function makeBriefingCtx(briefing?: string): DslContextInput {
  const state: StoryState = createInitialState({
    scene: { id: "scene_1", location: "旧校舍", purpose: "调查终端" },
  });
  const ctx: DslContextInput = {
    prompts: {
      characters: "【苏遥】转学生。",
      storyLine: "STORY_LINE_WITH_OLD_GLOBAL_TEXT",
      guideline: "guideline",
      dslProtocol: "dsl-protocol",
    },
    state,
    recentEvents: [],
    taskType: "continuation",
    generationNonce: "n-1",
    targetLines: 6,
    ...(briefing !== undefined ? { actorBriefing: briefing } : {}),
  } as DslContextInput;
  return ctx;
}

describe("buildActorBriefing", () => {
  it("renders directive sections (defense beats + ending pressure + form modes)", () => {
    const text = buildActorBriefing({
      directive: {
        sceneId: "scene_1",
        sceneGoal: "查清终端来历",
        defenseBeats: ["玩家试图离校时引回终端线索"],
        endingPressure: true,
        formModes: ["choice"],
      },
    });
    expect(text).toContain("[场景指令]");
    expect(text).toContain("目标：查清终端来历");
    expect(text).toContain("防守：玩家试图离校时引回终端线索");
    expect(text).toContain("收束：剧情接近终章");
    expect(text).toContain("表单模式收窄：choice");
  });

  it("renders memory projection sections (facts/beliefs/lessons)", () => {
    const text = buildActorBriefing({
      relatedFacts: [
        { id: "fact_1", content: "终端会对苏遥的指纹反应", evidenceEventSeqs: [1], checkpoint: 1, superseded: false },
      ],
      characterBeliefs: [
        { id: "belief_1", characterId: "苏遥", content: "苏遥相信终端是坏的", status: "active", createdAtCheckpoint: 1, origin: "believe" },
      ],
      avoidanceLessons: [
        { id: "lesson_1", tag: "setup-flow", content: "没有回收计划的伏笔不许下场", source: "rejection", occurrences: 2, active: true, createdAtCheckpoint: 1 },
      ],
    });
    expect(text).toContain("[相关既定事实]");
    expect(text).toContain("[角色认知]");
    expect(text).toContain("[规避清单]");
  });

  it("returns an empty string when there is nothing to brief (regression equivalence)", () => {
    expect(buildActorBriefing({})).toBe("");
    // 空 briefing 时 prompt 与「无便签」旧行为完全一致
    const withEmpty = buildDslUserPrompt(4, makeBriefingCtx(""));
    const without = buildDslUserPrompt(4, makeBriefingCtx(undefined));
    expect(withEmpty).toBe(without);
    expect(without).not.toContain("[场景指令]");
  });

  it("firewall: user prompt never contains unimplemented outline purposes or ending candidates", () => {
    // 未实现大纲的 purpose / 结局候选文本 —— 这些数据在 ActorBriefingInput
    // 类型上不存在；此处以「即便调用方持有也进不了剪报」的方式验证：
    // buildActorBriefing 的输出只可能来自其输入字段。
    const outlineSecret = "结局候选：主角黑化毁灭学园（未实现大纲 purpose）";
    const directive = buildActorBriefing({
      directive: {
        sceneId: "scene_1",
        sceneGoal: "调查旧校舍的终端",
        defenseBeats: [],
        endingPressure: false,
      },
    });
    expect(directive).not.toContain(outlineSecret);
    const prompt = buildDslUserPrompt(4, makeBriefingCtx(directive));
    expect(prompt).not.toContain(outlineSecret);
    expect(prompt).toContain("调查旧校舍的终端");
  });
});
