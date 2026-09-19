/**
 * 角色身份契约向量（character-identity contract vectors）——双分支共享。
 *
 * 计划：2026-09-19-character-identity-dsl-dual-branch-repair，任务 C1
 * （固定基线与契约复现）。本文件必须在两条产品线的工作树中保持字节
 * 一致（campus feat/identity-dsl-campus 与 main feat/identity-dsl-main
 * 各自提交同一内容）：这里只放共享向量数据，分支特有预期（main 无素材
 * 动态角色、campus 记忆中文名提案）放在各分支自己的
 * src/character-contract.test.ts，绝不放进本文件。
 *
 * 红绿纪律（控制器裁定）：
 * - RENAME_IDENTITY_CASE / VOICE_PROFILE_STABILITY_CASE /
 *   TEMPLATE_LITERAL_CASE 断言【期望】行为——当前应当失败（红灯即规格，
 *   由后续任务 C2+ 转绿，C1 不改产品行为）。
 * - PARSE_COLON_DIVERGENCE_CASE 固定【当前】缺陷行为并标注「待消除」：
 *   它是待消除行为的快照，不是未来兼容规范。
 *
 * 纯数据、零导入：两侧 tsconfig 均可原样编译，勿在此引入分支差异。
 */

/**
 * R01 — 改名后身份保持：改名（台词头 (显示名) 槽覆盖）之后，发给模型的
 * 上下文必须继续携带稳定内部 id female_A，音色必须等于原姓名版本。
 */
export const RENAME_IDENTITY_CASE = {
  requirement: "R01",
  /** 稳定内部 id（assets/resources.yaml 既有角色绑定，不重编号）。 */
  characterId: "female_A",
  /** 注册 script_name：模型在台词行头最自然写出的名字。 */
  scriptName: "许晚晴",
  /** 剧情中段生效的改名显示标签（(名称) 槽覆盖，持续到 () 复位）。 */
  renamedLabel: "神秘女子",
  /** 原名版本行头（对照基准，注册 script_name 直写）。 */
  originalLine: "许晚晴: 借过的那支笔，我还留着。",
  /** 改名版本行头：内部 id + (显示名) 槽。 */
  renamedLine: "female_A(神秘女子): 借过的那支笔，我还留着。",
  dialogueText: "借过的那支笔，我还留着。",
} as const;

/**
 * R02 — 音色跨标签稳定：同一 characterId 的事件，无论 speaker 是原注册
 * 名还是改名标签，AudioDescriptorFactory 必须解析出同一音频身份
 * （voiceId / voiceRevision / model；speakerId 恒为稳定 id）。
 * ttsConfigKey 特意取与资产 id 不同源的 TTS 配置键——这正是现状里
 * byId/bySpeaker/byName 三路全部落空、音色整体丢失的缺陷现场。
 */
export const VOICE_PROFILE_STABILITY_CASE = {
  requirement: "R02",
  ttsConfigKey: "xuwanqing",
  ttsConfigName: "许晚晴",
  voiceProfile: "xuwanqing_main",
  voiceIdEnv: "XUWANQING_VOICE_ID",
  voiceId: "xuwanqing-voice-001",
  /** 同一 line_id 让两次 build 的 cache key 可直接对照。 */
  lineId: "contract-line-r02",
} as const;

/**
 * R03 — 模板字面单遍替换：值里的 `{nonce}` 与 `$&` 都是字面量——
 * 不得二次展开（单遍），不得落入 String.replace 的替换模式语义
 * （`$&` 会展开成命中串）。实现按计划落在 C6 的
 * src/application/prompts/template.ts；C1 阶段模块尚不存在，
 * 导入失败即预期红灯。
 */
export const TEMPLATE_LITERAL_CASE = {
  requirement: "R03",
  /** 计划落地模块：相对 src/character-contract.test.ts（src/ 根）的限定符。 */
  plannedModule: "./application/prompts/template.js",
  template: "{player_input}|{nonce}",
  values: { player_input: "$& {nonce}", nonce: "N1" },
  expected: "$& {nonce}|N1",
} as const;

/**
 * R09 — 解析对照（固定当前行为，待消除）：未注册说话人「神秘女子」用
 * 半角冒号写行头被解析成 dialogue（凭空造出幻影说话人身份），用全角
 * 冒号写行头却整行降级为 narration——同一句台词因冒号全半角不同而
 * 走向两种身份。本向量只固定当前行为以便后续任务安全消除该分歧，
 * 不作为未来兼容规范。
 */
export const PARSE_COLON_DIVERGENCE_CASE = {
  requirement: "R09",
  status: "待消除（pinned current behavior — NOT a future compatibility spec）",
  unregisteredSpeaker: "神秘女子",
  asciiColonLine: "神秘女子: 你不该来这里。",
  fullwidthColonLine: "神秘女子：你不该来这里。",
  dialogueText: "你不该来这里。",
  /** 当前固定行为：半角冒号 → dialogue，speaker 为未注册名（幻影身份）。 */
  pinnedAsciiOutcome: { kind: "dialogue", speaker: "神秘女子" },
  /** 当前固定行为：全角冒号 → narration（正文被降级，说话人丢失）。 */
  pinnedFullwidthOutcome: { kind: "narration" },
} as const;
