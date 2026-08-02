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
import type { GameAppState } from "./app.js";
import { GameApp } from "./app.js";
import { buildAppDom, type AppDomRefs } from "./ui/layout.js";
import { StartScreen } from "./ui/start-screen.js";
import { DialogueBox } from "./ui/dialogue-box.js";
import { renderChoices } from "./ui/choices.js";
import { InputPanel, PreviewPanel } from "./ui/input-panel.js";
import { ControlsBar } from "./ui/controls.js";
import { EndScreen, ErrorBanner } from "./ui/end-screen.js";
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
  const inputPanel = new InputPanel(refs.inputRoot, {
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
  let draft: string | null = null;
  let lastPreviewText: string | null = null;

  const render = (state: GameAppState): void => {
    const view = state.view;
    const mode = view.mode;
    const modeChanged = mode !== lastMode;
    lastMode = mode;

    controls.setConnection(state.connection);
    controls.setAudio(state.audioPlaying, state.bufferedAheadMs);

    show(refs.startRoot, !started && mode === "BOOTSTRAP");
    show(refs.endRoot, mode === "ENDING");
    show(refs.bannerRoot, mode === "ERROR");
    show(refs.controlsRoot, mode !== "BOOTSTRAP" && mode !== "ENDING");

    show(refs.dialogueRoot, mode === "PLAYING");
    show(refs.choicesRoot, mode === "CHOICE_SELECTING");
    show(refs.inputRoot, mode === "INPUT_EDITING");
    show(refs.previewRoot, mode === "INPUT_PREVIEW");
    show(refs.waitingEl, mode === "CONTENT_WAITING" || (started && mode === "BOOTSTRAP"));

    if (mode === "PLAYING") {
      const line = view.currentLine;
      if (line !== undefined) {
        dialogueBox.setLine(line, state.showLineIds);
      }
    } else if (mode === "CHOICE_SELECTING" && modeChanged) {
      renderChoices(refs.choicesRoot, view.currentInteraction, (optionId) =>
        app.selectChoice(optionId),
      );
    } else if (mode === "INPUT_EDITING" && modeChanged) {
      if (draft !== null) {
        inputPanel.restoreDraft(draft);
        draft = null;
      } else {
        inputPanel.open(view.currentInteraction);
      }
    } else if (mode === "INPUT_PREVIEW") {
      const text = view.currentPreview?.text ?? "";
      if (modeChanged || text !== lastPreviewText) {
        lastPreviewText = text;
        draft = text;
        previewPanel.show(text);
      }
    } else if (mode === "ENDING" && modeChanged) {
      if (!endScreen.show(view.ending)) {
        errorBanner.show("结局数据缺失");
      }
    } else if (mode === "ERROR" && modeChanged) {
      errorBanner.show(view.lastError ?? "未知错误");
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
