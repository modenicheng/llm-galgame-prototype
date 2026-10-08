/**
 * DSL 组编译（game.ts 沿子系统缝移出）：把流式到达的 EventGroupDraft 编译
 * 成可播放事件（line_id 在此分配）、交互事件或纯舞台节拍，并以组为单位
 * 链接预测尾态（docs §56/§79——分支预取与输入回应路径复用）。
 *
 * 对装配方的访问经 DslGroupCompilerDeps；Game 侧保持 compileGroup/
 * materializeDslGroups 薄委托（InteractionHost 契约不变）。
 */
import { compileEventGroup } from "../core/protocol/gal-dsl/compiler.js";
import type {
  AssetDiagnostic,
  DslInteractionDraft,
  EventGroupDraft,
} from "../core/protocol/gal-dsl/types.js";
import type { AssetCatalog } from "../core/assets/types.js";
import type {
  CharacterRegistry,
  PresentationDefaults,
  StageCue,
  VisualState,
} from "../core/presentation/types.js";
import type { DiagnosticSink } from "../core/ports/diagnostic-sink.js";
import type { Metrics } from "./metrics.js";
import type { InteractionEvent, RuntimeDialogueEvent, RuntimeNarrationEvent, RuntimePlayableEvent } from "../schema.js";

export interface DslGroupCompilerDeps {
  registry: CharacterRegistry;
  reduce: (state: VisualState, cues: StageCue[]) => VisualState;
  defaultsFor: PresentationDefaults["defaultFor"];
  /** 缺省 = 无素材目录（诊断/语义校验关闭，未知素材不做计数）。 */
  catalog?: AssetCatalog;
  metrics: Pick<Metrics, "recordAssetDiagnostic">;
  diagnostics: DiagnosticSink;
  nextLineId(): string;
  buildRuntimeInteraction(draft: DslInteractionDraft, turn: number): InteractionEvent;
}

export function compileDslGroup(
  deps: DslGroupCompilerDeps,
  draft: EventGroupDraft,
  baseState: VisualState,
  turn: number,
): {
  playable: RuntimeDialogueEvent | RuntimeNarrationEvent | null;
  interaction: InteractionEvent | null;
  cues: StageCue[];
  tailState: VisualState;
} {
  const diagnostics: AssetDiagnostic[] = [];
  const compiled = compileEventGroup(draft, {
    registry: deps.registry,
    tailState: baseState,
    reduce: deps.reduce,
    defaultsFor: deps.defaultsFor,
    ...(deps.catalog !== undefined ? { catalog: deps.catalog, diagnostics } : {}),
  });
  for (const diagnostic of diagnostics) {
    deps.metrics.recordAssetDiagnostic(diagnostic.code);
    console.warn(`[assets] ${diagnostic.code}: ${diagnostic.id}`);
  }
  const main = compiled.group.main;
  if (main.type === "dialogue") {
    const event: RuntimeDialogueEvent = {
      type: "dialogue",
      characterId: main.characterId,
      speaker: main.speaker,
      text: main.text,
      line_id: deps.nextLineId(),
      ...(compiled.group.prelude.length > 0 ? { stage: compiled.group.prelude } : {}),
    };
    return { playable: event, interaction: null, cues: compiled.group.prelude, tailState: compiled.tailState };
  }
  if (main.type === "narration") {
    const event: RuntimeNarrationEvent = {
      type: "narration",
      text: main.text,
      line_id: deps.nextLineId(),
      ...(compiled.group.prelude.length > 0 ? { stage: compiled.group.prelude } : {}),
    };
    return { playable: event, interaction: null, cues: compiled.group.prelude, tailState: compiled.tailState };
  }
  if (main.type === "interaction") {
    const interaction = deps.buildRuntimeInteraction(main.interaction, turn);
    return { playable: null, interaction, cues: compiled.group.prelude, tailState: compiled.tailState };
  }
  // beat — pure stage node, no main event.
  return { playable: null, interaction: null, cues: compiled.group.prelude, tailState: compiled.tailState };
}

/**
 * Compile DSL groups into materialized playable events, chaining the
 * visual state across groups. Used by branch prefetch and input-response
 * paths (docs §56, §79).
 */
export function materializeDslGroups(
  deps: DslGroupCompilerDeps,
  groups: EventGroupDraft[],
  baseState: VisualState,
  turn: number,
): { events: RuntimePlayableEvent[]; tailState: VisualState } {
  let state = baseState;
  const events: RuntimePlayableEvent[] = [];
  for (const draft of groups) {
    const { playable, tailState } = compileDslGroup(deps, draft, state, turn);
    state = tailState;
    if (playable !== null) {
      events.push(playable);
    } else {
      deps.diagnostics.warn(
        "DSL",
        `片段跳过不可播放的组：${draft.main.type}`,
      );
    }
  }
  return { events, tailState: state };
}
