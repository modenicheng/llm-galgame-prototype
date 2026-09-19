/**
 * CanonStore port（执行清单 M3.6 ①）——跨周目世界既定（canon）的唯一入口。
 *
 * canon 是世界级共享真相（设计 §5.1）：worldSetting / characters 由世界生成
 * 落脚手架，promotedFacts / exceptions 由晋升管线（周目完结或弃局后台触发）
 * 写入。读取方是导演剪报与编剧维护输入——演员侧不入（§5.2 防火墙：晋升
 * 不回改既有快照，决议 D6，恢复靠 digest 嵌入而非 canon）。
 */

/**
 * 角色卡（与 OutlineWriterAdapter 的 DraftCharacter 同构；端口层不反向依赖
 * application）。M1 起 `control/initialLabel` 是权威元信息：世界生成必写；
 * 旧 canon（无 control）经显式判定走 legacy 兼容边界，不在此猜测。
 */
export interface CanonCharacter {
  id: string;
  name: string;
  description: string;
  /** M1 控制类型：恰一名 player（玩家契约），其余 npc。 */
  control?: "player" | "npc";
  /** M1 初始名牌（匿名起点）；缺省回落 name。 */
  initialLabel?: string;
  /** 复用 author 素材集（资源引用，不是身份合并）。 */
  spriteBinding?: string;
}

/** 晋升事实：跨 ≥2 周目佐证、经裁决入 canon 的 major fact。 */
export interface PromotedFact {
  id: string;
  content: string;
  /** 佐证该事实的周目 id（含已弃周目，决议 D7）。 */
  evidenceRuns: string[];
  /** 裁决方标识（如 "canon-adjudicator"）。 */
  judgedBy: string;
  /** ISO 时间戳。 */
  promotedAt: string;
}

/** 例外登记：与 canon 矛盾但允许存在的剧情事实，必须附补偿限制。 */
export interface CanonException {
  id: string;
  content: string;
  reason: string;
  /** 补偿限制：该例外在演出中的边界（如「仅限终章梦境段」）。 */
  compensatingLimit: string;
}

/** canon 当前态（canon.json 的形状；revision 由 store 维护）。 */
export interface CanonSnapshot {
  revision: number;
  worldSetting: string;
  characters: CanonCharacter[];
  promotedFacts: PromotedFact[];
  exceptions: CanonException[];
}

/** 晋升修订 op（判别联合）：裁决产物的落盘形态。 */
export type CanonOp =
  | { type: "promote"; fact: { id: string; content: string; evidenceRuns: string[] } }
  | {
      type: "exception";
      exception: { id: string; content: string; reason: string; compensatingLimit: string };
    };

export interface CanonStorePort {
  /** 当前 canon 全量（同步内存读取；须先 load）。 */
  getCanon(): CanonSnapshot;

  /** 启动路径的显式加载：缺文件 = 空 canon（revision 0）；损坏大声抛错。 */
  load(): Promise<CanonSnapshot>;

  /**
   * 世界生成的脚手架写入（worldSetting + characters，promoted/exceptions 空）。
   * 仅在 canon.json 不存在时合法——已存在则大声抛错，不覆写既有 canon。
   */
  saveScaffold(world: { worldSetting: string; characters: CanonCharacter[] }): Promise<void>;

  /**
   * 应用一批晋升修订：校验 → 原子写 canon.json → 追加 canon-log.jsonl
   * （append-only 修订留痕）。成功返回新修订号。
   */
  applyPromotion(ops: CanonOp[], reason: string): Promise<number>;
}
