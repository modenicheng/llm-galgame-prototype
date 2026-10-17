# 场景配乐 V2：主题制架构 + 作曲家第四 agent + 商业级渲染

状态：**已落地（2026-10-18，随五个提交实施：e656763 → 00ab0ef →
8b85623 → a108e81 → 探针/文档同步）**。运行规范见
`docs/scene-music-generation.md`（V2 重写）；前置 V1/V1.1/V1.2 历史见
同文。V1.2 把「地区特色」误解为民族音色维度（region 复用键）；V2 回归
真实需求：**主题制配乐**——同一场景日夜共用一个主题、同一游戏区域共用
一个主题、一局游戏最终形成数首曲目（像一张 OST 专辑）；复用与否由
作曲家 agent 在看过场景摘要与已有曲目目录后决定。

## 1. 目标架构（决策流）

```
导演 SceneDirective.music{mood,intensity,note}   ← note 升级为「情境一句话+编配提示」
  → SceneMusicService（V2 重写）
      1) bindings[sceneId] 已绑定主题 → 直接发布该主题谱面，零 LLM
         （覆盖日夜重访/重启续玩）
      2) 未绑定 → 组装 brief 调作曲家 agent（第四 agent，带持久会话）：
           输入 = 场景 brief + 主题目录（含动机提示与谱面统计）+ 最近会话轮次 + 作曲 skill
           输出 = {action:"reuse", themeId, reason} | {action:"compose", theme:{...}, score, reason}
      3) 持久化（主题目录 + 谱面 + sceneId 绑定 + 追加会话轮）→ publish
  → 浏览器渲染（渲染器 V2）
```

复用决策权在作曲家 agent：导演只给情绪/情境（prompt 不膨胀），目录与会话
在作曲家侧。目录为空时恒 compose。同一地点/相近情境必 reuse；mood 差异
不 fork 主题；只有导演 note 明示质变才建 parentTheme 变体；一局主题数
目标 5–15。

## 2. 数据层

`src/shared/music/theme.ts`（Node/Web 共用单一真源）：

- `MusicThemeMeta = { id: slug; title: 中文短名; concept: 一句话主题概念;
  style?: 风格短语（原地区知识降级为风格提示）; motifHint?: string
  （主题动机——服务层从谱面旋律轨确定性提取头 4–8 音，LLM 不写防幻觉）;
  parentTheme?: string（变体主题引用母题） }`
- zod schema + 决策契约 `ComposerDecision`（判别联合）与
  `SceneMusicBrief = { sceneId; sceneGoal?; mood; intensity; note? }`。

存储（GAME_STORAGE_LAYOUT 新增）：

- `musicThemes: "music/themes.json"` — `{version:1, themes:[], bindings:
  Record<sceneId, themeId>}`，运行期可增长（沿 stats.json 模式：tmp+rename
  原子重写、ENOENT=空、损坏大声抛错）
- `musicScoresDir: "music/scores"` — 每主题一文件 `<themeId>.json`
  （MusicScoreSchema 复验；首写即定稿，同 id 覆写 no-op）
- `musicSession: "music/session.jsonl"` — 作曲家会话，追加式：
  user=brief JSON / assistant=决策元数据（action/themeId/concept/reason +
  谱面统计一行），**不存完整谱面**（谱面在 scores/）。

新 store：`music-theme-store.ts`（themes.json + scores/ 一类管两处）、
`composer-session-store.ts`（append/read，损坏大声抛错）。

会话压缩：目录本身即持久记忆（音乐圣经），调用传「全量目录 + 最近 30
轮」；V2 不做 LLM 压缩，只做窗口截断（估算字符 > 300k 再引入压缩）。

## 3. 作曲家 agent

1. **作曲 skill**：`src/adapters/llm/music-composition-skill.ts` 导出
   `MUSIC_COMPOSITION_SKILL`（TS 模板字符串）。要点：全轨同 key/mode、
   先定 2–4 和弦循环、非和弦音仅短时值经过/邻音且须解决、跨轨禁小二度/
   三全音碰撞（延留解决除外）、bell 点缀必落和弦音、避平行五八度、bass
   走根音、pad 补根三五、末小节回主和弦或属七悬置、调式色彩用法、原 7
   地区创作思路降级为可选 style 语汇、主题动机复现规则（motifHint/
   parentTheme）。
2. **适配器重写** `scene-music-composer-adapter.ts`：
   `decide(brief, catalog, sessionTurns)`；system = 契约 + skill + 复用
   纪律；user = brief + 目录（含 key/mode/bpm/乐器/音符数统计，服务层
   从谱面补齐）+ 会话轮次进 messages 历史；JSON 单次调用，zod 判别联合
   校验，失败携 issue 修复重试一次，双败 null。预算：timeout ≥300s、
   max_tokens 16000、thinking disabled（听感不达标时第一调参项）。
3. **服务重写** `scene-music-service.ts`：按 §1 决策流；in-flight 按
   sceneId 合流；谱面/主题落盘失败仅告警；目录条目谱面读取失败按目录级
   降级（warn + 跳过）；compose 主题 id 与已有冲突时追加确定性短 hash
   后缀（不丢产物）；reuse 指向不存在主题 = 决策失败告警。
   `SceneMusicScoreEvent` 增 `themeId`，WS `music.score` 载荷加字段，
   `WIRE_PROTOCOL_VERSION` 3→4。
4. **导演侧**：`SceneDirective.music` 只剩 `{mood, intensity, note?}`；
   note ≤60 字 = 场景情境一句话 + 编配提示。
5. **bootstrap**：装配 MusicThemeStore/ComposerSessionStore/新适配器；
   `media.audio.music.enabled` 语义不变。

## 4. 渲染 V2（`web/src/audio/music-renderer.ts`）

1. 每轨：highpass(~40Hz) → StereoPanner（乐器固定声像）→ 轨增益 →
   分轨混响 send（bass 近干、bell/piano 多送）
2. 总线：DynamicsCompressor（-18dB/2.5:1/10ms/250ms）+ makeup
3. 后处理纯函数：RMS 归一 ≈ -16 dBFS、峰值钳 -1 dBFS（替换「>1 才缩」）
4. 采样率 32000 → 44100（soundfont 原生 44.1k）
5. `MUSIC_RENDERER_VERSION` 1→2
6. **乐器扩展 12 个**：piano/strings/pad/bass/bell/choir +
   guitar（钢弦拨弦）/harp（竖琴琶音）/flute（长笛）/marimba（马林巴）/
   organ（教堂管风琴）/synth（锯齿 lead）——score.ts 枚举 +
   vendor-soundfonts PACKS（CDN 切 fastly 镜像）+ 渲染器声像/增益/持续
   集合同提交（typecheck 强制穷尽映射）。skill 乐器语汇同步。
   分批编辑契约不做：单次 JSON + 16000 token 预算足够（reuse 分支天然省）。

## 5. 拆除清单（提交 1，先拆后建）

music-identity-store ± test 整删；outline-writer/adapter/world-generator
的 musicRegion；director prompt region 子句与解析分支、
SceneMusicDirection.region、MUSIC_REGIONS/MusicRegion/MUSIC_CONCRETE_REGIONS
（地区→创作思路文本迁入 V2 skill 作风格语汇）；scene-music-service 的
region 解析与 musicLibraryKey（V1.1 键 mood:intensity 过渡）；composer
adapter prompt 地区段；probe --region；demo-scores 标签去地区框架（谱面
保留作渲染 A/B 基线）；bootstrap worldRegion 装配。旧游戏
music/library.json、world/music-identity.json 自然孤儿化不迁移（本机无
games/ 存量）。

## 6. 提交切分

1. `refactor(music)!: 拆除地区维度`（§5，测试同步全绿）
2. `feat(music): 主题制数据层`（§2，含单测）
3. `feat(music): 作曲家 agent——skill/会话/决策`（§3，含单测 + WS v4）
4. `feat(music): 渲染 V2 混音母带链 + 乐器扩展`（§4，纯函数单测 + 版本 bump）
5. `chore(music): 探针/试听页/文档同步`（probe 打决策流真跑 BigModel 验证
   reuse+compose；scene-music-generation.md 重写 V2；status.md 音频节同步）
