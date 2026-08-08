/**
 * main.ts — browser bootstrap (§10.5, §9.2).
 *
 * Mounts the design-system layout, wires the widgets to the GameApp
 * controller, routes view-model states to the right panels, and owns the
 * ONE user gesture that unlocks autoplay: the Start click creates/resumes
 * the AudioContext, registers the worklet and opens the Runtime WebSocket.
 *
 * `boot()` is exported for tests; when the module loads in a page with
 * `#app` present it boots immediately.
 */
import type { FrontendMode } from "./runtime/game-view-model.js";
import { GameApp, interactionIdOf, type GameAppState } from "./app.js";
import { buildAppDom, type AppDomRefs } from "./ui/layout.js";
import { StartScreen } from "./ui/start-screen.js";
import { DialogueBox } from "./ui/dialogue-box.js";
import { InteractionPanel } from "./ui/interaction-panel.js";
import { PreviewPanel } from "./ui/input-panel.js";
import { ControlsBar } from "./ui/controls.js";
import { EndScreen, ErrorBanner } from "./ui/end-screen.js";
import { StageRenderer } from "./stage/stage-renderer.js";
import type { StageVisualState } from "./stage/stage-types.js";
import { show } from "./ui/dom.js";
import "./ui/styles.css";

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function wsUrlFromLocation(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/runtime`;
}

/** Create the AudioContext inside the Start gesture (§10.5). */
function createAudioContext(): AudioContext {
  const AudioCtor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioCtor === undefined) {
    throw new Error("当前浏览器不支持 Web Audio");
  }
  return new AudioCtor();
}

export function boot(root?: HTMLElement | null): void {
  const appRoot = root ?? document.getElementById("app");
  if (appRoot === null) return;

  const refs: AppDomRefs = buildAppDom(appRoot);
  const stageRenderer = new StageRenderer(refs.stage);
  const token = tokenFromUrl();
  const app = new GameApp({ wsUrl: wsUrlFromLocation(), token });

  const startScreen = new StartScreen(refs.startRoot, {
    onStart: async () => {
      const context = createAudioContext();
      if (context.state !== "running") {
        await context.resume(); // unlock within the gesture
      }
      try {
        await app.start(context); // worklet + cache + WebSocket (+ client.ready)
      } catch (error) {
        // A failed start must not wedge the session (P2): the app has already
        // reset its gate — surface the reason and let the user retry.
        errorBanner.show(error instanceof Error ? error.message : String(error));
        return;
      }
      started = true; // keep the gate closed once the session is underway
      startScreen.hide();
    },
  });
  if (token.length === 0) {
    startScreen.setWarning("未检测到会话令牌（?token=），本地服务可能拒绝连接");
  }

  const dialogueBox = new DialogueBox(refs.dialogueRoot, {
    onAdvance: () => app.advance(),
  });
  const interactionPanel = new InteractionPanel(refs.interactionRoot, {
    onSelect: (optionId) => app.selectChoice(optionId),
    onSubmit: (text) => app.submitInput(text),
  });
  const previewPanel = new PreviewPanel(refs.previewRoot, {
    onConfirm: () => app.confirmPreview(),
    onCancel: () => app.cancelPreview(),
  });
  const controls = new ControlsBar(
    refs.controlsRoot,
    {
      onModeToggle: (mode) => app.setMode(mode),
      onVolume: (v) => app.setVolume(v),
      onMute: (m) => app.setMuted(m),
      onSpeed: (cps) => {
        app.setTextSpeed(cps);
        dialogueBox.setCharsPerSecond(cps);
      },
    },
    { mode: "manual", volume: 1, muted: false, speed: 32 },
  );
  const endScreen = new EndScreen(refs.endRoot, {
    onRestart: () => window.location.reload(),
  });
  const errorBanner = new ErrorBanner(refs.bannerRoot);

  window.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return; // IME composition
    if (event.target instanceof HTMLButtonElement) return; // buttons self-handle
    const mode = app.state().view.mode;
    if (event.key === "Enter" || event.key === " ") {
      if (mode === "PLAYING") {
        event.preventDefault();
        dialogueBox.pressAdvance();
      } else if (mode === "INPUT_PREVIEW" && event.key === "Enter") {
        event.preventDefault();
        app.confirmPreview();
      }
    } else if (event.key === "Escape") {
      if (mode === "INPUT_PREVIEW") app.cancelPreview();
    }
  });

  // -------------------------------------------------------------------------
  // Render router
  // -------------------------------------------------------------------------

  let started = false;
  let lastMode: FrontendMode | null = null;
  let lastProjectionSeq = 0;
  let lastPreviewText: string | null = null;
  // Draft per interaction: a preview stores its text under the interaction id
  // so cancel restores it, while a NEW interaction never reuses an old draft
  // (§11.7).
  let draftByInteractionId = new Map<string, string>();
  let lastInteractionId: string | null = null;
  let lastVisualState: StageVisualState | undefined = undefined;

  const render = (state: GameAppState): void => {
    const view = state.view;
    const mode = view.mode;
    const modeChanged = mode !== lastMode;
    lastMode = mode;
    const projectionRestored = view.projectionSeq !== lastProjectionSeq;
    lastProjectionSeq = view.projectionSeq;

    controls.setConnection(state.connection);
    controls.setAudio(state.audioPlaying, state.bufferedAheadMs);

    show(refs.startRoot, !started && mode === "BOOTSTRAP");
    show(refs.endRoot, mode === "ENDING");
    show(refs.bannerRoot, mode === "ERROR");
    show(refs.controlsRoot, mode !== "BOOTSTRAP" && mode !== "ENDING");

    show(refs.dialogueRoot, mode === "PLAYING");
    show(refs.previewRoot, mode === "INPUT_PREVIEW");
    show(refs.waitingEl, mode === "CONTENT_WAITING" || (started && mode === "BOOTSTRAP"));

    const selectingMode =
      mode === "CHOICE_SELECTING" || mode === "HYBRID_SELECTING" || mode === "INPUT_EDITING";

    if (modeChanged || projectionRestored) {
      if (selectingMode) {
        const interactionId = interactionIdOf(view.currentInteraction);
        if (projectionRestored) {
          // §10.3: a reconnect projection re-opens the still-open
          // interaction, which resets the one-shot submit lock — a submit
          // during the dead socket was dropped by RuntimeClient.
          if (interactionId !== null && interactionId !== lastInteractionId) {
            draftByInteractionId.clear();
            lastInteractionId = interactionId;
          }
          interactionPanel.open(view.currentInteraction);
        } else {
          // A genuinely new interaction supersedes every older draft.
          if (interactionId !== null && interactionId !== lastInteractionId) {
            draftByInteractionId.clear();
            lastInteractionId = interactionId;
          }
          const draft =
            interactionId !== null ? draftByInteractionId.get(interactionId) : undefined;
          if (draft !== undefined && interactionId !== null) {
            draftByInteractionId.delete(interactionId);
            interactionPanel.restoreDraft(draft);
          } else {
            interactionPanel.open(view.currentInteraction);
          }
        }
      } else {
        interactionPanel.close();
      }
    }

    if (mode === "PLAYING") {
      const line = view.currentLine;
      if (line !== undefined) {
        dialogueBox.setLine(line, state.showLineIds);
      }
    } else if (mode === "INPUT_PREVIEW") {
      const text = view.currentPreview?.text ?? "";
      if (modeChanged || text !== lastPreviewText) {
        lastPreviewText = text;
        const interactionId = interactionIdOf(view.currentInteraction);
        if (interactionId !== null) {
          draftByInteractionId.set(interactionId, text);
        }
        previewPanel.show(text);
      }
    } else if (mode === "ENDING" && modeChanged) {
      if (!endScreen.show(view.ending)) {
        errorBanner.show("结局数据缺失");
      }
    } else if (mode === "ERROR" && modeChanged) {
      errorBanner.show(view.lastError ?? "未知错误");
    }

    // Stage picture (§86): re-render only when the view model hands us a
    // new visual-state object. Outputs/projections replace it wholesale, so
    // a reference check is enough — per-keystroke renders with the same
    // state stay cheap.
    const visualState = view.visualState;
    if (visualState !== undefined && visualState !== lastVisualState) {
      lastVisualState = visualState;
      stageRenderer.apply(visualState);
    }
  };

  app.subscribe((state) => {
    if (started || state.connection === "open" || state.view.mode !== "BOOTSTRAP") {
      started = true;
    }
    render(state);
  });
  render(app.state());
}

if (typeof document !== "undefined" && document.getElementById("app") !== null) {
  boot();
}
