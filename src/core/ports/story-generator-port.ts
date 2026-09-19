/**
 * Story generation port.
 *
 * The core depends on this interface, never on the OpenAI SDK. Each method
 * starts a generation and returns a `GenerationHandle` that exposes the
 * stream of parsed events as they arrive, the completion envelope, and
 * cancellation. Handles can be created from any promise + onEvent based
 * provider via `createGenerationHandle`.
 */
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  StoryContextEvent,
} from "../../schema.js";
import type { EventGroupDraft } from "../protocol/gal-dsl/types.js";
import type { GenerationEnvelope, StoryState } from "../../story/types.js";
import type { VisualState } from "../presentation/types.js";
import type { CastContext, CharacterRuntimeState } from "../characters/types.js";
import { AsyncEventQueue } from "../runtime/async-event-queue.js";

/**
 * C5 §5.1：每个生成请求显式携带的身份上下文。四项都必填——不携带
 * protocolVersion 的「隐式 v1」与不携带 rosterRevision 的「身份版本未知」
 * 都不允许再出现。
 */
export interface GenerationIdentity {
  /** 会话 DSL 协议版本（config dsl.protocol_version；默认 1，未翻）。 */
  protocolVersion: 1 | 2;
  /** 本局 registry 的 roster revision（身份版本，绑定快照与预取副本）。 */
  rosterRevision: string;
  /** 允许发声 cast 与场景参与者（§3.4；空 allowedSpeakerIds = 无 NPC 台词）。 */
  cast: CastContext;
  /** 名牌运行时状态快照（预取分支持副本，未选/取消/修复失败即丢弃）。 */
  characterState: CharacterRuntimeState;
}

/** 请求身份的兼容视图（roster 缺席的 legacy 会话/窄测试夹具）。 */
export function legacyGenerationIdentity(
  cast: CastContext,
): GenerationIdentity {
  return {
    protocolVersion: 1,
    rosterRevision: "legacy",
    cast,
    characterState: { labels: Object.create(null) },
  };
}

export interface OpeningRequest {
  /** C5：身份上下文（协议版本 / roster revision / cast / 名牌状态）。 */
  identity: GenerationIdentity;
  turn: number;
  state: StoryState;
  signal?: AbortSignal;
  /** 导演剪报文本（M4.2 剪报通道；buildDslUserPrompt 易变区渲染）。 */
  briefing?: string;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface ContinuationRequest {
  /** C5：身份上下文（协议版本 / roster revision / cast / 名牌状态）。 */
  identity: GenerationIdentity;
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  prefetchedEvents: StoryContextEvent[];
  signal?: AbortSignal;
  /** 导演剪报文本（M4.2 剪报通道；buildDslUserPrompt 易变区渲染）。 */
  briefing?: string;
  /** §8.5 修复原因：上一段失败的上下文，嵌入用户 prompt。 */
  repairReason?: string;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface BranchPrefetchRequest {
  /** C5：身份上下文（协议版本 / roster revision / cast / 名牌状态）。 */
  identity: GenerationIdentity;
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  choice: ChoiceEvent;
  option: ChoiceOption;
  signal?: AbortSignal;
  /** 导演剪报文本（M4.2 剪报通道；buildDslUserPrompt 易变区渲染）。 */
  briefing?: string;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface InputResponseRequest {
  /** C5：身份上下文（协议版本 / roster revision / cast / 名牌状态）。 */
  identity: GenerationIdentity;
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  interaction: InteractionEvent;
  playerInput: string;
  signal?: AbortSignal;
  /** 导演剪报文本（M4.2 剪报通道；buildDslUserPrompt 易变区渲染）。 */
  briefing?: string;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface InputBridgeRequest {
  /** C5：身份上下文（协议版本 / roster revision / cast / 名牌状态）。 */
  identity: GenerationIdentity;
  turn: number;
  state: StoryState;
  interaction: InteractionEvent;
  signal?: AbortSignal;
  /** 导演剪报文本（M4.2 剪报通道；buildDslUserPrompt 易变区渲染）。 */
  briefing?: string;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface GenerationHandle {
  /** Stable identifier of this generation task. */
  id: string;
  /** Committed DSL event groups as they arrive (docs §36). */
  events: AsyncIterable<EventGroupDraft>;
  /** Resolves with the full envelope; rejects when the task fails/aborts. */
  done: Promise<GenerationEnvelope>;
  /** Ask the provider to stop producing further events. */
  cancel(reason?: string): void;
}

export interface StoryGeneratorPort {
  generateOpening(request: OpeningRequest): GenerationHandle;
  generateContinuation(request: ContinuationRequest): GenerationHandle;
  generateBranchPrefetch(request: BranchPrefetchRequest): GenerationHandle;
  generateInputResponse(request: InputResponseRequest): GenerationHandle;
  generateInputBridge(request: InputBridgeRequest): GenerationHandle;
}

/** Shape of the underlying promise-based provider a handle wraps. */
export type GenerationRunner = (
  signal: AbortSignal,
  onGroup: (group: EventGroupDraft) => void,
) => Promise<GenerationEnvelope>;

/**
 * Compatibility wrapper: adapt an existing `Promise<GenerationEnvelope>` +
 * `onGroup` provider into a `GenerationHandle` without rewriting the
 * provider's internals.
 */
export function createGenerationHandle(
  id: string,
  run: GenerationRunner,
): GenerationHandle {
  const controller = new AbortController();
  const queue = new AsyncEventQueue<EventGroupDraft>();

  const done = run(controller.signal, (group) => queue.push(group)).finally(() =>
    queue.close(),
  );

  return {
    id,
    events: queue,
    done,
    cancel: (reason?: string) => {
      if (reason === undefined) {
        controller.abort();
      } else {
        controller.abort(new DOMException(reason, "AbortError"));
      }
    },
  };
}
