import io, re

with io.open('src/game.ts', 'r', encoding='utf-8', newline='') as f:
    t = f.read().replace('\r\n', '\n')
lines = t.split('\n')

RANGES = [
    ('resolveInteraction', 1072, 1077),
    ('createBranchManagerForTerminal', 1253, 1268),
    ('startBridgePrefetch', 1344, 1400),
    ('cancelBridgePrefetch', 1403, 1409),
    ('adoptSelectedBranch', 1435, 1517),
    ('handleChoice', 1518, 1578),
    ('createBranchManager', 1890, 1960),
    ('handleInteractionInput', 2005, 2226),
    ('startInputResponseGeneration', 2232, 2328),
    ('stageResponseEvent', 2333, 2346),
    ('makePlayerDialogue', 2347, 2359),
    ('handleHybridInteraction', 2360, 2521),
    ('countBufferedDialogues', 2522, 2527),
    ('recordPlayerChoice', 2528, 2541),
    ('recordPlayerInput', 2542, 2559),
    ('recordPlayerDialogue', 2560, 2574),
]
moved_names = set(n for n, _, _ in RANGES)

# host members referenced (from analysis) -> these become the InteractionHost
HOST_FIELDS = {
    'status': 'RuntimeStatus',
    'metrics': 'Metrics',
    'diagnostics': 'DiagnosticSink',
    'clock': 'ClockPort',
    'ids': 'IdGeneratorPort',
    'config': 'AppConfig',
    'generator': 'StoryGeneratorPort',
    'media': 'MediaPlannerPort',
    'narrativeDirector': 'NarrativeDirectorPort | undefined',
    'seq': 'number',
    'activeInteractionId': 'string | null',
    'activePreviewId': 'string | null',
    'choiceTimestamp': 'number | null',
    'inputConfirmAtMs': 'number | null',
    'storyState': 'StoryState',
    'tailVisualState': 'VisualState',
    'events': 'StoredEvent[]',
    'bridgeBuffer': 'InputBridgeBuffer',
    'inputEngine': 'InputEngine',
    'bridgeControllers': 'Map<string, AbortController>',
    'branchTailStates': 'Map<string, VisualState>',
    'bridgeLineIds': 'Set<string>',
    'responseLineIds': 'Set<string>',
    'buffered': 'Map<string, RuntimePlayableEvent>',
    'reduce': '(state: VisualState, cues: StageCue[]) => VisualState',
}
HOST_METHODS = {
    'emit': 'output: RuntimeOutput) => void; signature: (output: RuntimeOutput): void',
}
# hand-written method signatures added directly in the interface template

# ---- extract blocks ----
blocks = []
for name, s, e in RANGES:
    # walk start back over preceding doc comments (already included in range by analysis)
    body = '\n'.join(lines[s - 1:e])
    blocks.append((name, s, e, body))

def rewrite_body(body):
    def repl(m):
        ident = m.group(1)
        if ident in moved_names:
            return m.group(0)
        return 'this.host.' + ident
    return re.sub(r'this\.([A-Za-z_][A-Za-z0-9_]*)', repl, body)

driver_methods = []
for name, s, e, body in blocks:
    body = rewrite_body(body)
    # strip `private ` visibility (keep async)
    body = re.sub(r'^  private (async )?', '  ', body, flags=re.M)
    driver_methods.append(body)
driver_body = '\n\n  '.join(driver_methods)

INTERFACE = '''/**
 * InteractionHost —— InteractionDriver 对 Game 宿主成员的最小视图（M4.5）。
 * Game 实现本接口；这些成员即 game.ts 拆分后对交互驱动簇的公开接缝。
 */
export interface InteractionHost {
  status: RuntimeStatus;
  metrics: Metrics;
  diagnostics: DiagnosticSink;
  clock: ClockPort;
  ids: IdGeneratorPort;
  config: AppConfig;
  generator: StoryGeneratorPort;
  media: MediaPlannerPort;
  narrativeDirector: NarrativeDirectorPort | undefined;
  seq: number;
  activeInteractionId: string | null;
  activePreviewId: string | null;
  choiceTimestamp: number | null;
  inputConfirmAtMs: number | null;
  storyState: StoryState;
  tailVisualState: VisualState;
  events: StoredEvent[];
  bridgeBuffer: InputBridgeBuffer;
  inputEngine: InputEngine;
  bridgeControllers: Map<string, AbortController>;
  branchTailStates: Map<string, VisualState>;
  bridgeLineIds: Set<string>;
  responseLineIds: Set<string>;
  buffered: Map<string, RuntimePlayableEvent>;
  reduce: (state: VisualState, cues: StageCue[]) => VisualState;

  emit(output: RuntimeOutput): void;
  makeBriefing(turn: number): string | undefined;
  openInteractionStage(interactionId: string): StagePresentationDelta | undefined;
  waitForCommand(predicate: (command: RuntimeCommand) => boolean): Promise<RuntimeCommand>;
  waitForInteractionCommand(
    interactionId: string,
    acceptedTypes: Readonly<Partial<Record<"select_choice" | "preview_input", true>>>,
  ): Promise<Extract<RuntimeCommand, { type: "select_choice" | "preview_input" }>>;
  record(event: StoredEvent): Promise<void>;
  nextLineId(): string;
  materializeDslGroups(
    groups: EventGroupDraft[],
    baseState: VisualState,
    turn: number,
  ): { events: RuntimePlayableEvent[]; tailState: VisualState };
  compileGroup(
    draft: EventGroupDraft,
    baseState: VisualState,
    turn: number,
  ): {
    playable: RuntimeDialogueEvent | RuntimeNarrationEvent | null;
    tailState: VisualState;
    stage: StageCue[];
  };
  registerBuffered(events: RuntimePlayableEvent[]): void;
}
'''

IMPORTS = '''/**
 * InteractionDriver —— 交互驱动（choice/input/hybrid + 两阶段提交 + 分支
 * 预取接线 + 桥接预取），自 game.ts 沿子系统缝移出（执行清单 M4.5）。
 *
 * 驱动通过 `InteractionHost` 最小视图访问宿主（Game）状态与宿主方法；
 * 行为零变化——方法体自 game.ts 原样迁移，仅 `this.` → `this.host.`。
 */
import type { AppConfig } from "../config.js";
import type { ClockPort } from "../core/ports/clock-port.js";
import type { DiagnosticSink } from "../core/ports/diagnostic-sink.js";
import type { IdGeneratorPort } from "../core/ports/id-generator-port.js";
import type { MediaPlannerPort } from "../core/ports/media-planner-port.js";
import type { NarrativeDirectorPort } from "../core/ports/narrative-director-port.js";
import type { StoryGeneratorPort } from "../core/ports/story-generator-port.js";
import type { RuntimeCommand } from "../core/runtime/runtime-command.js";
import type { RuntimeOutput } from "../core/runtime/runtime-output.js";
import { InputBridgeBuffer } from "../core/interaction/input-bridge.js";
import { InputEngine } from "../interaction/input-engine.js";
import { BranchManager } from "./branch-manager.js";
import type { LiveBranchSelection } from "./prefetch.js";
import { Metrics } from "./metrics.js";
import type {
  ActiveSegment,
  InputCommitOutcome,
  SegmentOutcome,
} from "./segment-types.js";
import type { MemoryProjection } from "../core/narrative/memory-projection.js";
import type {
  ChoiceOption,
  InteractionEvent,
  InputInteraction,
  HybridInteraction,
  PlayerDialogueEvent,
  StoredEvent,
  StoredPlayerChoiceEvent,
  StoredPlayerInputEvent,
  StoredPlayerDialogueEvent,
  StoryContextEvent,
  RuntimePlayableEvent,
} from "../schema.js";
import type {
  StageCue,
  StagePresentationDelta,
  VisualState,
} from "../core/presentation/types.js";
import type { StoryState } from "../story/types.js";

'''

BODY_HEAD = 'export class InteractionDriver {\n  constructor(private readonly host: InteractionHost) {}\n\n'

with io.open('src/runtime/interaction-driver.ts', 'w', encoding='utf-8', newline='') as f:
    f.write((IMPORTS + INTERFACE + BODY_HEAD + driver_body + '\n}\n').replace('\n', '\r\n'))
print('interaction-driver.ts written')

# ---- segment-types.ts: move the type block (lines 99-177) ----
seg_start = lines.index('interface ActiveSegment {')
seg_end = lines.index('type SegmentOutcome = ChoiceOutcome | EndOutcome | BufferOutcome;')
type_block = '\n'.join(lines[seg_start:seg_end + 1])
# export everything
type_block = re.sub(r'^interface ', 'export interface ', type_block, flags=re.M)
type_block = re.sub(r'^type ', 'export type ', type_block, flags=re.M)
seg_header = '''/**
 * 段生命周期类型（执行清单 M4.5：自 game.ts 迁出，Game 与
 * InteractionDriver 共用）。纯类型。
 */
import type { AsyncEventQueue } from "../core/runtime/async-event-queue.js";
import type { SegmentEndStatus } from "../core/protocol/gal-dsl/types.js";
import type { BranchManager } from "./branch-manager.js";
import type { RuntimeModelEvent, RuntimePlayableEvent } from "../schema.js";
import type { InputResponseSession, LiveBranchSelection } from "./prefetch.js";

'''
with io.open('src/runtime/segment-types.ts', 'w', encoding='utf-8', newline='') as f:
    f.write((seg_header + type_block + '\n').replace('\n', '\r\n'))
print('segment-types.ts written, type lines:', seg_start + 1, '-', seg_end + 1)

# ---- rewrite game.ts ----
# remove moved blocks (from bottom up to keep line numbers)
for name, s, e in sorted(RANGES, key=lambda r: -r[1]):
    # include trailing blank line
    e2 = e
    while e2 < len(lines) - 1 and lines[e2].strip() == '':
        e2 += 1
    del lines[s - 1:e2]

# remove type block, replace with import
i = lines.index('interface ActiveSegment {')
j = lines.index('type SegmentOutcome = ChoiceOutcome | EndOutcome | BufferOutcome;')
lines[i:j + 1] = [
    '// 段生命周期类型已迁至 ./runtime/segment-types.ts（M4.5 交互驱动拆分）。',
]

t = '\n'.join(lines)
# imports
t = t.replace('''import { BranchManager } from "./runtime/branch-manager.js";''',
'''import { BranchManager } from "./runtime/branch-manager.js";
import { InteractionDriver, type InteractionHost } from "./runtime/interaction-driver.js";
import type {
  ActiveSegment,
  SegmentOutcome,
  InputCommitOutcome,
  ChoiceOutcome,
  ChoiceSelection,
  InputCommitOutcome as _InputCommitAlias,
} from "./runtime/segment-types.js";''')
t = t.replace('''  InputCommitOutcome as _InputCommitAlias,
} from "./runtime/segment-types.js";''', '''  ChoiceSelection,
} from "./runtime/segment-types.js";''')

# call-site switching
for name in moved_names:
    t = t.replace(f'this.{name}(', f'this.interactionDriver.{name}(')

# class implements + driver field
t = t.replace('export class Game {', 'export class Game implements InteractionHost {', 1)
t = t.replace('''  private readonly commands = new AsyncEventQueue<RuntimeCommand>();''',
'''  private readonly commands = new AsyncEventQueue<RuntimeCommand>();
  /** M4.5：交互驱动（choice/input/hybrid + 两阶段提交 + 分支/桥接预取）。 */
  private readonly interactionDriver: InteractionDriver;''')
# ctor: assign driver first thing — anchor at start of ctor body
ctor_anchor = '    this.metrics = metrics ?? new Metrics();'
assert ctor_anchor in t
t = t.replace(ctor_anchor, '''    this.interactionDriver = new InteractionDriver(this);
''' + ctor_anchor, 1)

write('src/game.ts', t)
print('game.ts rewritten')
