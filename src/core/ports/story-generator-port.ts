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
import type { NarrativeBrief } from "../narrative/narrative-brief.js";
import type { VisualState } from "../presentation/types.js";
import { AsyncEventQueue } from "../runtime/async-event-queue.js";

export interface OpeningRequest {
  turn: number;
  state: StoryState;
  signal?: AbortSignal;
  brief?: NarrativeBrief;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface ContinuationRequest {
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  prefetchedEvents: StoryContextEvent[];
  signal?: AbortSignal;
  brief?: NarrativeBrief;
  /** §8.5 修复原因：上一段失败的上下文，嵌入用户 prompt。 */
  repairReason?: string;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface BranchPrefetchRequest {
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  choice: ChoiceEvent;
  option: ChoiceOption;
  signal?: AbortSignal;
  brief?: NarrativeBrief;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface InputResponseRequest {
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  interaction: InteractionEvent;
  playerInput: string;
  signal?: AbortSignal;
  brief?: NarrativeBrief;
  /** DSL 模式：模型继续前的舞台尾部视觉状态（docs §70）。 */
  tailVisualState?: VisualState;
}

export interface InputBridgeRequest {
  turn: number;
  state: StoryState;
  interaction: InteractionEvent;
  signal?: AbortSignal;
  brief?: NarrativeBrief;
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
