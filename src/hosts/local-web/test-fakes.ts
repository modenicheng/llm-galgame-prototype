/**
 * Shared fakes for the local web host tests: fake Game, fake projection,
 * fake TtsTaskService, and the standard descriptor/recipe fixtures.
 */
import { vi, type Mock } from "vitest";
import type { Game } from "../../game.js";
import type { UiProjectionStore } from "../../application/ui/ui-projection-store.js";
import type { TtsTaskService } from "../../application/audio/tts-task-service.js";
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";
import type { UiProjection } from "../../shared/wire/ui-projection.js";
import type { AudioDescriptor } from "../../shared/wire/audio-descriptor.js";
import type { InternalAudioRecipe } from "../../application/audio/internal-audio-recipe.js";
import type { RuntimeOutput } from "../../core/runtime/runtime-output.js";
import type { TtsCompletion, TtsStreamSession } from "../../core/ports/tts-provider-port.js";

export const testDescriptor: AudioDescriptor = {
  lineId: "line_1",
  cacheKey: "cache_1",
  scope: { type: "active" },
  priority: "current",
  speakerId: "heroine",
  displaySpeaker: "女主",
  format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
};

export const testRecipe: InternalAudioRecipe = {
  lineId: "line_1",
  cacheKey: "cache_1",
  text: "你好",
  model: "cosyvoice_v3_flash",
  voiceId: "voice-1",
  voiceRevision: 0,
  rate: 1,
  pitch: 1,
  pauseBeforeMs: 0,
  pauseAfterMs: 0,
  volume: 1,
  seed: 42,
};

export interface FakeGameHandle {
  game: Game;
  emit: (output: RuntimeOutput) => void;
  dispatch: Mock;
  subscribe: Mock;
}

export function makeFakeGame(): FakeGameHandle {
  const listeners = new Set<(output: RuntimeOutput) => void>();
  const subscribe = vi.fn((listener: (output: RuntimeOutput) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const dispatch = vi.fn();
  return {
    game: {
      subscribe,
      dispatch,
      run: vi.fn(async () => {}),
    } as unknown as Game,
    emit: (output) => {
      for (const listener of [...listeners]) listener(output);
    },
    dispatch,
    subscribe,
  };
}

export function makeFakeProjection(
  snapshot: UiProjection = { phase: "idle", recentLines: [] },
): { projection: UiProjectionStore; setSnapshot: (p: UiProjection) => void } {
  let current = snapshot;
  return {
    projection: {
      snapshot: () => current,
      applyOutput: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } as unknown as UiProjectionStore,
    setSnapshot: (next) => {
      current = next;
    },
  };
}

/** Standard synthetic session: two chunks, completion resolves at stream end. */
export function makeSession(chunks: Uint8Array[] = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]): TtsStreamSession {
  const { promise, resolve } = Promise.withResolvers<TtsCompletion>();
  const emit = (async function* () {
    for (const chunk of chunks) yield chunk;
    resolve({ totalBytes: 5 });
  })();
  return {
    metadata: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1, bitDepth: 16 },
    chunks: emit,
    completion: promise,
  };
}

/**
 * Fake TtsTaskService. The session is produced by an injectable factory so
 * tests can build abort-aware streams that observe the request signal.
 */
export class FakeTtsTasks implements TtsTaskService {
  calls: Array<{ request: AudioFetchRequest; signal: AbortSignal }> = [];
  createSession: ((signal: AbortSignal) => TtsStreamSession) | null = null;
  error: Error | null = null;

  async synthesize(request: AudioFetchRequest, signal: AbortSignal): Promise<TtsStreamSession> {
    this.calls.push({ request, signal });
    if (this.error) throw this.error;
    if (!this.createSession) throw new Error("no session factory configured");
    return this.createSession(signal);
  }
}
