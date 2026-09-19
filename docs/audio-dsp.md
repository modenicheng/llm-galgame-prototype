# 音频动态处理（DSP）管线

语音 gate/压缩/限幅、BGM 动态链与语音驱动闪避（ducking）的架构、参数与调参指南。
参数可在 `/monitor` 操作台「音频」tab 编辑并保存（落盘 `audio-dsp.yaml`，玩家端
即时热生效），也可以直接手改该文件（下次启动生效）。

## 信号拓扑

```
TTS PCM 流 ──► pcm-playback worklet ──► dynamics worklet(voice, mono) ──► voiceGain ──► 出口
                                            │ 电平/gate/GR 遥测（≈21ms）
回看回放（ClipPlayer）──────────────────────┘（并入语音链，同一路 DSP 与音量）
                                            ▼
                              BgmDucker（threshold/attack/hold/release/depth）
                                            │ setTargetAtTime
<audio> BGM ──► MediaElementSource ──► dynamics worklet(bgm, stereo) ──► fadeGain ──► duckGain ──► 出口
                                        （压缩/限幅，默认关）     （淡入淡出）  （闪避）
```

- 语音链与 BGM 链复用同一个 `"dynamics"` AudioWorklet 处理器（`web/src/audio/`
  `dynamics-worklet.js`，自包含纯 JS + 条件 `registerProcessor`，可被 vitest 直接
  import 测曲线）。处理器名在同一 AudioContext 上只能注册一次，因此 BGM 总线
  必须在 `AudioCoordinator.init()` 之后创建（`GameApp.start` 内完成）。
- `BgmDucker`（`web/src/audio/bgm-duck.ts`）消费语音链的**输出电平**（过完 DSP
  后的真实可听电平），句内停顿经 `hold` 防抖，`release` 回弹；增益写入用
  `setTargetAtTime`（时间常数 τ = ms/3000，即 ms 内走完约 95%），主线程只在
  目标变化的边沿调用。
- 淡入淡出从旧的 rAF 插值 `audio.volume` 迁移到采样级精确的 `fadeGain`
  GainNode；`audio.volume` 只承担用户音量/静音。

## 降级路径（逐级旁路，绝不因 DSP 挂掉游戏）

| 失败点 | 行为 |
| --- | --- |
| 无 AudioWorklet 环境（旧 webview） | 与引入 DSP 之前完全一致（text-only 播放策略不变） |
| dynamics 模块加载失败 | 语音链直连（worklet → gain → 出口）；闪避静默关闭 |
| `createMediaElementSource` 失败 | BGM 保持旧的 `audio.volume` 直连路径，淡入淡出回写元素音量 |
| BGM dynamics 节点创建失败 | BGM 仍在图内（source → fadeGain → duckGain），只是不过动态处理 |

## 参数模型（单一来源）

`src/shared/wire/audio-dsp.ts`（zod schema + 默认值），Node 端（加载/保存路由）
与浏览器端（初始参数/热更推送/面板）共用。鲁棒性语义：单个坏字段（类型错、
越界、null）一律回落默认值并 clamp 进合法区间，绝不让整份配置失效；只有顶层
不是对象才判非法。

| 组 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| voice | enabled | true | 语音链总开关（关 = DSP 旁路，闪避仍可用） |
| voice.gate | threshold_db / attack_ms / hold_ms / release_ms / range_db | −55 / 5 / 150 / 250 / −70 | 低于阈值的段落衰减到 range_db；hold 防句内停顿抖动 |
| voice.compressor | threshold_db / ratio / attack_ms / release_ms / knee_db / makeup_db | −26 / 2.5 / 8 / 150 / 6 / 0 | 软膝压缩；默认近透明 |
| voice.limiter | ceiling_db / release_ms | −1.5 / 80 | 输出天花板（固定 0.5ms 快 attack），防 TTS 瞬态炸音 |
| bgm | enabled + compressor/limiter | 链开、两级处理关 | 成品音乐一般已母带处理；gate 对音乐无意义 |
| ducking | threshold_db / depth_db / attack_ms / hold_ms / release_ms | −42 / −12 / 150 / 350 / 900 | 语音电平高于阈值 → BGM 压低 depth_db |

## 持久化：audio-dsp.yaml

- 位置：仓库根（与 config.yaml 同目录），随 `web.ts` 入口按 configPath 目录解析。
- **所有权**：程序写回（`POST /api/config/audio-dsp`，`AudioDspStore` 原子写：
  tmp + rename）。首次保存前可以不存在；仓库内提交的种子文件带注释，首次保存
  后注释会被程序格式覆盖——参数含义以本文档为准。
- 手改允许：坏字段回落默认、越界 clamp（见上）；config.yaml 与本文件互不写入。
- 加载纪律：缺文件 → 默认值（info）；坏文件 → 默认值 + warn（fail-open）。与
  config.yaml 的 fail-fast 不同——本文件可被程序写回，不值得为它 brick 启动。

## 保存与热生效链路

```
/monitor 音频 tab「保存」
  → POST /api/config/audio-dsp（X-Session-Token；zod 校验；AudioDspStore 原子写盘）
  → host 就地刷新 GET /api/config 快照（dsp 块）
  → RuntimeWebSocket.notifyAudioDsp 广播 {type:"audio.dsp", params}
  → 玩家端 runtime-client → GameApp.setDspParams（语音链 / BGM 链 / 闪避三处热更）
```

双窗口联调：玩家页开局听音，/monitor 改参数保存，玩家页立即生效；仪表同步。

## 遥测与仪表

- 玩家端 dynamics worklet 每 ≈21ms post `{type:"state"}`（输出电平、gate 开合、
  压缩/限幅 GR）→ `GameApp` 10Hz 聚合 → `/ws/runtime` 上行 `audio.telemetry`
  → `MonitorHub.updateAudioState`（无订阅者即丢弃）→ 400ms 状态轮询差分下发
  → /monitor 音频 tab 仪表。
- `/ws/monitor` 通道保持只读不变；参数写入走 REST。

## 调参建议

1. **TTS 响度不稳/炸音**：保持限幅开，`ceiling_db` −1.5 左右；嫌动态小把压缩
   `ratio` 提到 3~4、`threshold_db` 提到 −22，配 `makeup_db` 2~4。
2. **TTS 句间呼吸声/底噪**：门限 `threshold_db` 从 −55 往上提（−45 起），注意
   别咬掉句尾气声；`hold_ms` 拉长可防句内短停顿被误闭。
3. **BGM 压语音/垫不住**：闪避 `depth_db` −10~−18；`attack_ms` 100~200 保证
   不「抢拍」，`release_ms` 600~1200 让音乐自然回弹；`threshold_db` 大约在
   语音稳态电平下方 5~10dB。
4. 后台标签页：闪避由 worklet（音频线程）驱动，不被 rAF 节流影响；淡入淡出
   帧回调暂停属既有行为。
