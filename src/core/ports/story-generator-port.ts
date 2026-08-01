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
  ModelEvent,
  StoryContextEvent,
} from "../../schema.js";
import type { GenerationEnvelope, StoryState } from "../../story/types.js";
import { AsyncEventQueue } from "../runtime/async-event-queue.js";

export interface OpeningRequest {
  turn: number;
  state: StoryState;
  signal?: AbortSignal;
}

export interface ContinuationRequest {
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  prefetchedEvents: StoryContextEvent[];
  signal?: AbortSignal;
}

export interface BranchPrefetchRequest {
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  choice: ChoiceEvent;
  option: ChoiceOption;
  signal?: AbortSignal;
}

export interface InputResponseRequest {
  turn: number;
  state: StoryState;
  history: StoryContextEvent[];
  interaction: InteractionEvent;
  playerInput: string;
  signal?: AbortSignal;
}

export interface GenerationHandle {
  /** Stable identifier of this generation task. */
  id: string;
  /** Parsed model events as they arrive, one per completed JSONL line. */
  events: AsyncIterable<ModelEvent>;
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
}

/** Shape of the underlying promise-based provider a handle wraps. */
export type GenerationRunner = (
  signal: AbortSignal,
  onEvent: (event: ModelEvent) => void,
) => Promise<GenerationEnvelope>;

/**
 * Compatibility wrapper: adapt an existing `Promise<GenerationEnvelope>` +
 * `onEvent` provider into a `GenerationHandle` without rewriting the
 * provider's internals.
 */
export function createGenerationHandle(
  id: string,
  run: GenerationRunner,
): GenerationHandle {
  const controller = new AbortController();
  const queue = new AsyncEventQueue<ModelEvent>();

  const done = run(controller.signal, (event) => queue.push(event)).finally(() =>
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
