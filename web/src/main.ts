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
import { fetchAssetManifest } from "./stage/asset-manifest-client.js";
import { BrowserAssetResolver } from "./stage/browser-asset-resolver.js";
import { BgmController } from "./stage/bgm-controller.js";
import { SoundEffectController } from "./stage/sound-effect-controller.js";
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

export async function boot(root?: HTMLElement | null): Promise<void> {
  const appRoot = root ?? document.getElementById("app");
  if (appRoot === null) return;

  const refs: AppDomRefs = buildAppDom(appRoot);
  const manifest = await fetchAssetManifest();
  const assetResolver = new BrowserAssetResolver(manifest);
  const stageRenderer = new StageRenderer(refs.stage, assetResolver);
  const bgmController = new BgmController(assetResolver);
  const seController = new SoundEffectController(assetResolver);
  const token = tokenFromUrl();
  const app = new GameApp({ wsUrl: wsUrlFromLocation(), token, bgmController });

  const startScreen = new StartScreen(refs.startRoot, {
    onStart: async () => {
      const context = createAudioContext();
      if (context.state !== "running") {
        await context.resume(); // unlock within the gesture
      }
      bgmController.unlock(); // 手势内解锁 BGM autoplay 策略
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

  // M3.3 直通开玩：无既有世界时显示描述输入框 + 开局按钮。
  // 提交 → POST /api/worlds（服务端换绑到新世界）→ 刷新进入正常开局流程。
  void (async () => {
    try {
      const response = await fetch("/api/config");
      const config = (await response.json()) as { has_world?: boolean };
      if (config.has_world !== false) return;
      const form = document.createElement("div");
      form.className = "world-create";
      form.innerHTML = [
        '<h2>创建你的世界</h2>',
        '<p>用一段话描述你想要的世界与故事，编剧将生成大纲并直接开局。</p>',
        '<textarea id="world-create-text" rows="6" placeholder="例如：平行世界的学园都市，转学生苏遥带着一台会对指纹反应的旧终端……"></textarea>',
        '<button id="world-create-button" type="button">生成世界并开局</button>',
        '<p id="world-create-error" style="color:#c0392b"></p>',
      ].join("");
      appRoot.appendChild(form);
      const button = form.querySelector<HTMLButtonElement>("#world-create-button")!;
      const textarea = form.querySelector<HTMLTextAreaElement>("#world-create-text")!;
      const error = form.querySelector<HTMLParagraphElement>("#world-create-error")!;
      button.addEventListener("click", async () => {
        const text = textarea.value.trim();
        if (text.length === 0) {
          error.textContent = "请先填写世界描述。";
          return;
        }
        button.disabled = true;
        error.textContent = "生成中……（约需数十秒）";
        try {
          const createResponse = await fetch("/api/worlds", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!createResponse.ok) {
            const body = (await createResponse.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `HTTP ${createResponse.status}`);
          }
          window.location.reload();
        } catch (err) {
          error.textContent = err instanceof Error ? err.message : String(err);
          button.disabled = false;
        }
      });
    } catch {
      // /api/config 不可得时按「已有世界」处理，不阻塞正常启动。
    }
  })();

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
      bgmController.apply(visualState.bgm);
      seController.consume(app.consumeCues());
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
  void boot();
}
