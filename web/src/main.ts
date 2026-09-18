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
import { EndScreen } from "./ui/end-screen.js";
import { installStageUiScale } from "./ui/stage-ui-scale.js";
import { StageRenderer } from "./stage/stage-renderer.js";
import { fetchAssetManifest } from "./stage/asset-manifest-client.js";
import { BrowserAssetResolver } from "./stage/browser-asset-resolver.js";
import { BgmController } from "./stage/bgm-controller.js";
import { SoundEffectController } from "./stage/sound-effect-controller.js";
import type { StageVisualState } from "./stage/stage-types.js";
import {
  loadPlayerSettings,
  savePlayerSettings,
  type PlayerSettings,
} from "./storage/player-settings.js";
import { SettingsMenu } from "./ui/settings-menu.js";
import { BacklogOverlay } from "./ui/backlog-overlay.js";
import { setText, show } from "./ui/dom.js";
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
  installStageUiScale(refs.stage); // 主 UI 随 16:9 框等比缩放（--ui-scale）
  const bgmController = new BgmController(assetResolver);
  const seController = new SoundEffectController(assetResolver);
  const token = tokenFromUrl();
  // Player preferences persist across reloads (booth restarts, accidental
  // refreshes): restore once here and save on every change below.
  const playerSettings: PlayerSettings = loadPlayerSettings();
  const persistSettings = (): void => savePlayerSettings(playerSettings);
  const app = new GameApp({
    wsUrl: wsUrlFromLocation(),
    token,
    bgmController,
    initialSettings: playerSettings,
  });

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
        // reset its gate — surface the reason on the start screen and retry.
        startScreen.setWarning(
          error instanceof Error ? error.message : String(error),
        );
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
  dialogueBox.setCharsPerSecond(playerSettings.textSpeed);
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
      onOpenSettings: () => toggleSettings(),
      onOpenBacklog: () => toggleBacklog(),
      onRestart: () => {
        // Mid-session restart loses progress; the end-screen path does not
        // need this guard (nothing is left to lose).
        if (window.confirm("重开会丢弃当前进度并开启新一局，确定吗？")) {
          beginRestart();
        }
      },
    },
    { mode: "manual" },
  );
  const settingsMenu = new SettingsMenu(
    refs.controlsRoot,
    {
      onVoiceVolume: (v) => {
        playerSettings.voiceVolume = v;
        app.setVoiceVolume(v);
        persistSettings();
      },
      onBgmVolume: (v) => {
        playerSettings.bgmVolume = v;
        app.setBgmVolume(v);
        persistSettings();
      },
      onMute: (m) => {
        playerSettings.muted = m;
        app.setMuted(m);
        persistSettings();
      },
      onTextSpeed: (cps) => {
        playerSettings.textSpeed = cps;
        app.setTextSpeed(cps);
        dialogueBox.setCharsPerSecond(cps);
        persistSettings();
      },
    },
    {
      voiceVolume: playerSettings.voiceVolume,
      bgmVolume: playerSettings.bgmVolume,
      muted: playerSettings.muted,
      textSpeed: playerSettings.textSpeed,
    },
    { anchor: controls.settingsTrigger },
  );
  // 浮层（设置/回看）打开期间控制条常显，否则鼠标离开角落时入口随栏淡出。
  const syncControlsPinned = (): void => {
    refs.controlsRoot.classList.toggle(
      "controls--pinned",
      settingsMenu.isOpen() || backlogOverlay.isOpen,
    );
  };
  const toggleSettings = (): void => {
    settingsMenu.toggle();
    controls.setSettingsOpen(settingsMenu.isOpen());
    syncControlsPinned();
  };

  // ---------------------------------------------------------------------------
  // 回看（backlog）：历史浏览 + 缓存语音回放。打开 = app 挂起故事推进；
  // 面板期间新行照常追加。Esc/L 可开关；结局/报错/重开自动关闭。
  // ---------------------------------------------------------------------------
  const backlogOverlay = new BacklogOverlay(refs.backlogRoot, {
    onClose: () => closeBacklog(),
    onReplay: (lineId) => {
      void app.replayLine(lineId); // 不可回放时状态由 render 路由刷新
    },
    onStopReplay: () => app.stopReplay(),
  });
  const openBacklog = (): void => {
    if (backlogOverlay.isOpen) return;
    app.setBacklogOpen(true);
    backlogOverlay.open(app.backlogEntries(), app.state().replayLineId);
    controls.setBacklogOpen(true);
    syncControlsPinned();
  };
  const closeBacklog = (): void => {
    if (!backlogOverlay.isOpen) return;
    app.setBacklogOpen(false);
    backlogOverlay.close();
    controls.setBacklogOpen(false);
    syncControlsPinned();
  };
  const toggleBacklog = (): void => {
    if (backlogOverlay.isOpen) closeBacklog();
    else openBacklog();
  };
  const endScreen = new EndScreen(refs.endRoot, {
    onRestart: () => beginRestart(),
  });

  // ---------------------------------------------------------------------------
  // Session restart (campus booth): ask the host to rebuild the runtime with
  // a fresh session id (rotating the narrative seed). The rebased websocket
  // pushes a new projection snapshot; the render router picks the new session
  // up from there. Buttons stay pending until it lands (8s failsafe).
  // ---------------------------------------------------------------------------
  let restartPending = false;
  let restartFailsafe: number | null = null;
  const endRestartPending = (): void => {
    restartPending = false;
    if (restartFailsafe !== null) {
      clearTimeout(restartFailsafe);
      restartFailsafe = null;
    }
    endScreen.setRestartPending(false);
    controls.setRestartPending(false);
  };
  const beginRestart = (): void => {
    if (restartPending) return;
    restartPending = true;
    endScreen.setRestartPending(true);
    controls.setRestartPending(true);
    app.restartSession();
    restartFailsafe = window.setTimeout(endRestartPending, 8000);
  };

  window.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return; // IME composition
    // 设置菜单打开时独占键盘：Esc 关闭它，其余按键不进入剧情路由
    // （面板里的滑杆/复选框需要方向键与空格，且菜单后的舞台不应推进）。
    if (settingsMenu.isOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        settingsMenu.close();
        controls.setSettingsOpen(false);
        syncControlsPinned();
      }
      return;
    }
    // 回看面板打开时同样独占：Esc/L 关闭，其余按键不推进剧情
    // （点击与自动推进已被 app 挂起，这里挡键盘路径）。
    if (backlogOverlay.isOpen) {
      if (event.key === "Escape" || event.key === "l" || event.key === "L") {
        event.preventDefault();
        closeBacklog();
      }
      return;
    }
    const mode = app.state().view.mode;
    // L（log）：gal 惯例回看快捷键；开场/结局页不响应。
    if (
      (event.key === "l" || event.key === "L") &&
      mode !== "BOOTSTRAP" &&
      mode !== "ENDING"
    ) {
      event.preventDefault();
      openBacklog();
      return;
    }
    // Esc has no native button behavior, so it is handled BEFORE the
    // button-target guard below: with a preview button focused (Tab), Esc
    // must still reach cancelPreview instead of being swallowed.
    if (event.key === "Escape") {
      if (mode === "INPUT_PREVIEW") {
        event.preventDefault();
        app.cancelPreview();
      }
      return;
    }
    if (event.target instanceof HTMLButtonElement) return; // buttons self-handle
    if (event.key === "Enter" || event.key === " ") {
      if (mode === "PLAYING") {
        event.preventDefault();
        dialogueBox.pressAdvance();
      } else if (mode === "INPUT_PREVIEW" && event.key === "Enter") {
        event.preventDefault();
        app.confirmPreview();
      }
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
  let lastSessionId: string | undefined = undefined;

  const render = (state: GameAppState): void => {
    const view = state.view;
    const mode = view.mode;
    const modeChanged = mode !== lastMode;
    lastMode = mode;
    const projectionRestored = view.projectionSeq !== lastProjectionSeq;
    lastProjectionSeq = view.projectionSeq;

    controls.setConnection(state.connection);
    controls.setAudio(state.audioPlaying, state.bufferedAheadMs);
    controls.setSessionId(view.sessionId);

    // A session id change means the runtime was rebuilt (restart): drop the
    // old session's stage picture and form state so the new story opens clean.
    if (lastSessionId !== undefined && view.sessionId !== lastSessionId) {
      lastSessionId = view.sessionId;
      lastVisualState = undefined;
      lastInteractionId = null;
      draftByInteractionId.clear();
      stageRenderer.clear();
      closeBacklog(); // 回看是旧会话的历史，随新会话一起收起
      if (restartPending) endRestartPending();
    } else if (view.sessionId !== undefined) {
      lastSessionId = view.sessionId;
    }

    show(refs.startRoot, !started && mode === "BOOTSTRAP");
    show(refs.endRoot, mode === "ENDING");
    show(refs.controlsRoot, mode !== "BOOTSTRAP" && mode !== "ENDING");
    // 结局/报错时回看面板自动收起（重开入口在结束页上）。
    if ((mode === "ENDING" || mode === "ERROR") && backlogOverlay.isOpen) {
      closeBacklog();
    }

    show(refs.dialogueRoot, mode === "PLAYING");
    show(refs.previewRoot, mode === "INPUT_PREVIEW");
    show(
      refs.waitingEl,
      mode === "CONTENT_WAITING" || (started && mode === "BOOTSTRAP"),
    );
    // 生成过程痕迹不上玩家端：等待页只保留静态文案，后台续写/修复链等
    // 阶段细节属于操作员信息（/monitor 实时流），不在这里露出。
    setText(refs.waitingPhaseEl, "");

    const selectingMode =
      mode === "CHOICE_SELECTING" || mode === "HYBRID_SELECTING" || mode === "INPUT_EDITING";

    // 表单/预览出现时压暗舞台（.stage__veil），保证表单文字可读；预览是
    // 同一次交互的确认页，一并遮罩。无条件按模式驱动，重连投影同样恢复。
    show(refs.interactionVeil, selectingMode || mode === "INPUT_PREVIEW");

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
    } else if (mode === "INPUT_PREVIEW") {      const text = view.currentPreview?.text ?? "";
      if (modeChanged || text !== lastPreviewText) {
        lastPreviewText = text;
        const interactionId = interactionIdOf(view.currentInteraction);
        if (interactionId !== null) {
          draftByInteractionId.set(interactionId, text);
        }
        previewPanel.show(text);
      }
    } else if (mode === "ENDING" && modeChanged) {
      if (!endScreen.show(view.ending, view.sessionId)) {
        console.warn("ending event missing/invalid", view.ending);
      }
    } else if (mode === "ERROR") {
      // Fatal generation failure: the stage freezes on its last picture and
      // generation traces stay off the player screen by design — the
      // operator diagnoses via /monitor. The controls-bar restart button
      // remains the recovery entry point.
    }

    // 回看面板开着：随状态刷新（新行追加 / 回放指示变化；update 内部有
    // diff，列表形状未变时零 DOM 操作）。
    if (backlogOverlay.isOpen) {
      backlogOverlay.update(app.backlogEntries(), state.replayLineId);
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
  const appRoot = document.getElementById("app");
  // Route split: /monitor boots the observability dashboard (same SPA
  // shell + session token); everything else is the player page.
  const isMonitorRoute = window.location.pathname.replace(/\/+$/, "").endsWith("/monitor");
  if (isMonitorRoute && appRoot !== null) {
    void import("./monitor/boot.js").then((module) => module.bootMonitor(appRoot));
  } else {
    void boot();
  }
}
