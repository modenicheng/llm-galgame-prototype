/**
 * AudioPanel — /monitor「音频」tab：DSP 参数编辑 + 保存 + 实时仪表。
 *
 * 参数读自 GET /api/config（audio-dsp.yaml 的浏览器安全投影，服务端
 * AudioDspStore 持有）；保存走 POST /api/config/audio-dsp（带会话 token），
 * 服务端落盘后向玩家端广播 audio.dsp 热生效。仪表数据来自状态帧的
 * audio 遥测（玩家端 10Hz 聚合 → MonitorHub → 状态轮询差分下发）。
 */
import { defaultAudioDspParams, type AudioDspParams } from "@shared/wire/audio-dsp.js";
import type { MonitorAudioState } from "@shared/wire/monitor-message.js";
import { el } from "../ui/dom.js";

interface SliderSpec {
  /** 参数路径，如 "voice.gate.threshold_db"。 */
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 数值展示（缺省 `${v}`）。 */
  fmt?: (v: number) => string;
}

interface SubGroupSpec {
  /** 子组开关路径；null = 无独立开关。 */
  enablePath: string | null;
  title: string;
  sliders: SliderSpec[];
}

const DB = (v: number): string => `${v.toFixed(1)} dB`;
const MS = (v: number): string => `${Math.round(v)} ms`;
const RATIO = (v: number): string => `${v.toFixed(1)}:1`;

const GROUPS: { enablePath: string; title: string; note: string; subs: SubGroupSpec[] }[] = [
  {
    enablePath: "voice.enabled",
    title: "语音链（TTS）",
    note: "gate → 压缩 → 限幅，依次作用；回看回放共用此链",
    subs: [
      {
        enablePath: "voice.gate.enabled",
        title: "门限 gate",
        sliders: [
          { path: "voice.gate.threshold_db", label: "阈值", min: -80, max: 0, step: 0.5, fmt: DB },
          { path: "voice.gate.attack_ms", label: "开门", min: 0, max: 200, step: 1, fmt: MS },
          { path: "voice.gate.hold_ms", label: "保持", min: 0, max: 1000, step: 5, fmt: MS },
          { path: "voice.gate.release_ms", label: "释放", min: 0, max: 1000, step: 5, fmt: MS },
          { path: "voice.gate.range_db", label: "衰减下限", min: -80, max: 0, step: 0.5, fmt: DB },
        ],
      },
      {
        enablePath: "voice.compressor.enabled",
        title: "压缩 compressor",
        sliders: [
          { path: "voice.compressor.threshold_db", label: "阈值", min: -80, max: 0, step: 0.5, fmt: DB },
          { path: "voice.compressor.ratio", label: "比率", min: 1, max: 20, step: 0.1, fmt: RATIO },
          { path: "voice.compressor.attack_ms", label: "启动", min: 0, max: 100, step: 1, fmt: MS },
          { path: "voice.compressor.release_ms", label: "释放", min: 0, max: 1000, step: 5, fmt: MS },
          { path: "voice.compressor.knee_db", label: "软膝", min: 0, max: 24, step: 0.5, fmt: DB },
          { path: "voice.compressor.makeup_db", label: "补偿", min: -24, max: 24, step: 0.5, fmt: DB },
        ],
      },
      {
        enablePath: "voice.limiter.enabled",
        title: "限幅 limiter",
        sliders: [
          { path: "voice.limiter.ceiling_db", label: "天花板", min: -20, max: 0, step: 0.1, fmt: DB },
          { path: "voice.limiter.release_ms", label: "释放", min: 0, max: 500, step: 5, fmt: MS },
        ],
      },
    ],
  },
  {
    enablePath: "bgm.enabled",
    title: "BGM 链",
    note: "默认全关（成品音乐一般已母带处理）；闪避不在此开关内",
    subs: [
      {
        enablePath: "bgm.compressor.enabled",
        title: "压缩 compressor",
        sliders: [
          { path: "bgm.compressor.threshold_db", label: "阈值", min: -80, max: 0, step: 0.5, fmt: DB },
          { path: "bgm.compressor.ratio", label: "比率", min: 1, max: 20, step: 0.1, fmt: RATIO },
          { path: "bgm.compressor.attack_ms", label: "启动", min: 0, max: 200, step: 1, fmt: MS },
          { path: "bgm.compressor.release_ms", label: "释放", min: 0, max: 1000, step: 5, fmt: MS },
          { path: "bgm.compressor.knee_db", label: "软膝", min: 0, max: 24, step: 0.5, fmt: DB },
          { path: "bgm.compressor.makeup_db", label: "补偿", min: -24, max: 24, step: 0.5, fmt: DB },
        ],
      },
      {
        enablePath: "bgm.limiter.enabled",
        title: "限幅 limiter",
        sliders: [
          { path: "bgm.limiter.ceiling_db", label: "天花板", min: -20, max: 0, step: 0.1, fmt: DB },
          { path: "bgm.limiter.release_ms", label: "释放", min: 0, max: 500, step: 5, fmt: MS },
        ],
      },
    ],
  },
  {
    enablePath: "ducking.enabled",
    title: "BGM 闪避（语音驱动）",
    note: "语音链输出电平高于阈值时压低 BGM；深度/节奏在此调",
    subs: [
      {
        enablePath: null,
        title: "",
        sliders: [
          { path: "ducking.threshold_db", label: "触发阈值", min: -80, max: 0, step: 0.5, fmt: DB },
          { path: "ducking.depth_db", label: "压低深度", min: -60, max: 0, step: 0.5, fmt: DB },
          { path: "ducking.attack_ms", label: "压下", min: 0, max: 1000, step: 5, fmt: MS },
          { path: "ducking.hold_ms", label: "保持", min: 0, max: 2000, step: 10, fmt: MS },
          { path: "ducking.release_ms", label: "回弹", min: 0, max: 3000, step: 10, fmt: MS },
        ],
      },
    ],
  },
];

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function assignPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[keys[i]!];
  }
  if (cur !== null && typeof cur === "object") {
    (cur as Record<string, unknown>)[keys[keys.length - 1]!] = value;
  }
}

/** 组→子组→行 的启停关系（构建期登记，sync 时统一驱动）。 */
interface SubRows {
  enablePath: string | null;
  rows: HTMLElement;
}
interface GroupRows {
  enablePath: string;
  subs: SubRows[];
}

export class AudioPanel {
  private params: AudioDspParams = defaultAudioDspParams();
  private dirty = false;
  private loaded = false;
  private readonly valueLabels = new Map<string, HTMLElement>();
  private readonly sliders = new Map<string, HTMLInputElement>();
  private readonly enableControls = new Map<string, HTMLInputElement>();
  private readonly groups: GroupRows[] = [];
  private readonly statusEl: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly formEl: HTMLElement;
  private readonly metersEl: HTMLElement;
  private readonly meterOutBar: HTMLElement;
  private readonly meterOutText: HTMLElement;
  private readonly meterGateText: HTMLElement;
  private readonly meterCompText: HTMLElement;
  private readonly meterLimText: HTMLElement;
  private readonly meterDuckBar: HTMLElement;
  private readonly meterDuckText: HTMLElement;
  private readonly waitingHint: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly token: string,
  ) {
    // ---- 仪表区 ----
    const meters = el("div", "mon-audio-meters");
    this.metersEl = meters;
    const outRow = el("div", "mon-audio-meter");
    outRow.appendChild(el("span", "mon-audio-meter__label", "语音电平"));
    const outTrack = el("div", "mon-audio-meter__track");
    this.meterOutBar = el("div", "mon-audio-meter__bar");
    outTrack.appendChild(this.meterOutBar);
    this.meterOutText = el("span", "mon-audio-meter__value", "—");
    outRow.appendChild(outTrack);
    outRow.appendChild(this.meterOutText);
    const gateRow = el("div", "mon-audio-meter");
    gateRow.appendChild(el("span", "mon-audio-meter__label", "门限"));
    this.meterGateText = el("span", "mon-audio-meter__value", "—");
    gateRow.appendChild(this.meterGateText);
    const grRow = el("div", "mon-audio-meter");
    grRow.appendChild(el("span", "mon-audio-meter__label", "压缩 GR"));
    this.meterCompText = el("span", "mon-audio-meter__value", "—");
    grRow.appendChild(this.meterCompText);
    grRow.appendChild(el("span", "mon-audio-meter__label", "限幅 GR"));
    this.meterLimText = el("span", "mon-audio-meter__value", "—");
    grRow.appendChild(this.meterLimText);
    const duckRow = el("div", "mon-audio-meter");
    duckRow.appendChild(el("span", "mon-audio-meter__label", "闪避深度"));
    const duckTrack = el("div", "mon-audio-meter__track");
    this.meterDuckBar = el("div", "mon-audio-meter__bar");
    duckTrack.appendChild(this.meterDuckBar);
    this.meterDuckText = el("span", "mon-audio-meter__value", "—");
    duckRow.appendChild(duckTrack);
    duckRow.appendChild(this.meterDuckText);
    meters.appendChild(outRow);
    meters.appendChild(gateRow);
    meters.appendChild(grRow);
    meters.appendChild(duckRow);
    this.waitingHint = el("div", "mon-audio-waiting", "等待玩家端遥测（需已开局且玩家页存活）…");
    meters.appendChild(this.waitingHint);

    // ---- 参数表单 ----
    const form = el("div", "mon-audio-form");
    this.formEl = form;
    for (const group of GROUPS) {
      const box = el("div", "mon-audio-group");
      const head = el("div", "mon-audio-group__head");
      const groupEnable = this.buildEnable(group.enablePath);
      head.appendChild(groupEnable);
      head.appendChild(el("span", "mon-audio-group__title", group.title));
      head.appendChild(el("span", "mon-audio-group__note", group.note));
      box.appendChild(head);
      const groupRows: GroupRows = { enablePath: group.enablePath, subs: [] };
      for (const sub of group.subs) {
        const subHead = el("div", "mon-audio-sub__head");
        if (sub.enablePath !== null) {
          subHead.appendChild(this.buildEnable(sub.enablePath));
        }
        if (sub.title !== "") subHead.appendChild(el("span", "mon-audio-sub__title", sub.title));
        box.appendChild(subHead);
        const rows = el("div", "mon-audio-rows");
        for (const spec of sub.sliders) {
          rows.appendChild(this.buildSliderRow(spec));
        }
        box.appendChild(rows);
        groupRows.subs.push({ enablePath: sub.enablePath, rows });
      }
      this.groups.push(groupRows);
      form.appendChild(box);
    }

    // ---- 底栏 ----
    const foot = el("div", "mon-audio-foot");
    this.statusEl = el("span", "mon-audio-status", "加载中…");
    const resetBtn = el("button", "mon-tab", "恢复默认") as HTMLButtonElement;
    resetBtn.addEventListener("click", () => {
      this.params = defaultAudioDspParams();
      this.refreshControls();
      this.markDirty();
      this.setStatus("已恢复内置默认（尚未保存）");
    });
    this.saveBtn = el("button", "mon-tab mon-audio-save", "保存") as HTMLButtonElement;
    this.saveBtn.addEventListener("click", () => void this.save());
    foot.appendChild(this.statusEl);
    foot.appendChild(resetBtn);
    foot.appendChild(this.saveBtn);

    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.appendChild(meters);
    container.appendChild(form);
    container.appendChild(foot);
    this.syncEnableStates();

    void this.load();
  }

  /** 状态帧遥测（状态轮询 400ms 节流；仅活动 tab 时由 boot 调用）。 */
  updateMeters(state: MonitorAudioState | undefined): void {
    // 帧内自带 at 时间戳：玩家页断连/关闭后最后一条数据会常驻 hub，超过
    // 2s 视为过期——仪表灰显，避免把「数据已死」误读成「静音」。
    const stale = state !== undefined && Date.now() - state.at > 2000;
    this.metersEl.classList.toggle("is-stale", stale);
    if (state === undefined || stale) {
      this.waitingHint.style.display = "";
      this.waitingHint.textContent =
        state === undefined
          ? "等待玩家端遥测（需已开局且玩家页存活）…"
          : "遥测中断（玩家页已关闭或断连）…";
      return;
    }
    this.waitingHint.style.display = "none";
    const outPct = Math.round(((Math.max(-60, Math.min(0, state.outDb)) + 60) / 60) * 100);
    this.meterOutBar.style.width = `${outPct}%`;
    this.meterOutText.textContent = `${state.outDb.toFixed(1)} dB`;
    this.meterGateText.textContent = state.gateOpen ? "开" : "闭";
    this.meterGateText.classList.toggle("is-open", state.gateOpen);
    this.meterCompText.textContent = `${state.compGrDb.toFixed(1)} dB`;
    this.meterLimText.textContent = `${state.limGrDb.toFixed(1)} dB`;
    const duckPct = Math.round((Math.min(24, state.duckDb) / 24) * 100);
    this.meterDuckBar.style.width = `${duckPct}%`;
    this.meterDuckText.textContent = `-${state.duckDb.toFixed(1)} dB`;
  }

  private buildEnable(path: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      assignPath(this.params, path, input.checked);
      this.markDirty();
      this.syncEnableStates();
    });
    this.enableControls.set(path, input);
    return input;
  }

  private buildSliderRow(spec: SliderSpec): HTMLElement {
    const row = el("div", "mon-audio-row");
    row.appendChild(el("span", "mon-audio-row__label", spec.label));
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.addEventListener("input", () => {
      const value = Number.parseFloat(slider.value);
      if (Number.isFinite(value)) {
        assignPath(this.params, spec.path, value);
        this.updateValueLabel(spec, value);
        this.markDirty();
      }
    });
    this.sliders.set(spec.path, slider);
    const value = el("span", "mon-audio-row__value", "—");
    this.valueLabels.set(spec.path, value);
    row.appendChild(slider);
    row.appendChild(value);
    return row;
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { audio?: { dsp?: unknown } };
      const dsp = json.audio?.dsp;
      if (dsp === null || dsp === undefined || typeof dsp !== "object") {
        throw new Error("config 缺少 audio.dsp");
      }
      this.params = dsp as AudioDspParams;
      this.loaded = true;
      this.dirty = false;
      this.refreshControls();
      this.syncDirty();
      this.setStatus("已加载当前参数");
    } catch (error) {
      this.setStatus(`加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async save(): Promise<void> {
    if (!this.loaded) return;
    this.saveBtn.disabled = true;
    // 保存期间锁表单：否则在途编辑会被服务端回填覆盖（静默丢失）。
    this.formEl.classList.add("is-saving");
    this.setStatus("保存中…");
    try {
      const res = await fetch("/api/config/audio-dsp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": this.token },
        body: JSON.stringify(this.params),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { ok: boolean; params: AudioDspParams };
      this.params = json.params; // 服务端规范化后的值回填
      this.refreshControls();
      this.dirty = false;
      this.syncDirty();
      this.setStatus(`已保存 ${new Date().toLocaleTimeString()}（玩家端已热生效）`);
    } catch (error) {
      this.setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saveBtn.disabled = false;
      this.formEl.classList.remove("is-saving");
    }
  }

  /** 把 this.params 刷回全部控件（加载/保存/恢复默认后）。 */
  private refreshControls(): void {
    for (const [path, slider] of this.sliders) {
      const value = getPath(this.params, path);
      if (typeof value === "number") slider.value = String(value);
    }
    for (const [path, label] of this.valueLabels) {
      const value = getPath(this.params, path);
      if (typeof value !== "number") continue;
      const spec = this.specByPath(path);
      if (spec !== null) label.textContent = (spec.fmt ?? String)(value);
    }
    for (const [path, control] of this.enableControls) {
      control.checked = getPath(this.params, path) === true;
    }
    this.syncEnableStates();
  }

  private updateValueLabel(spec: SliderSpec, value: number): void {
    const label = this.valueLabels.get(spec.path);
    if (label !== undefined) label.textContent = (spec.fmt ?? String)(value);
  }

  /** 组/子组开关禁用其滑条行（半透明）。 */
  private syncEnableStates(): void {
    for (const group of this.groups) {
      const groupOn = getPath(this.params, group.enablePath) === true;
      for (const sub of group.subs) {
        const subOn = sub.enablePath === null ? true : getPath(this.params, sub.enablePath) === true;
        sub.rows.classList.toggle("is-disabled", !(groupOn && subOn));
      }
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.syncDirty();
  }

  private syncDirty(): void {
    this.saveBtn.classList.toggle("is-dirty", this.dirty);
    if (!this.dirty && this.loaded) this.setStatus("已保存");
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private specByPath(path: string): SliderSpec | null {
    for (const group of GROUPS) {
      for (const sub of group.subs) {
        const found = sub.sliders.find((spec) => spec.path === path);
        if (found !== undefined) return found;
      }
    }
    return null;
  }
}
