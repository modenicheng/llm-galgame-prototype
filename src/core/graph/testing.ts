/**
 * 图契约测试夹具（仅供测试导入）——最小合法的 StateSnapshot 与图记录
 * 构造器。纯数据，无 IO。
 */
import type {
  DecisionNode,
  InteractionFormSnapshot,
  PlotEdge,
  SnapshotIdentityState,
  StateSnapshot,
} from "./types.js";
import { SNAPSHOT_IDENTITY_SCHEMA_VERSION } from "../ports/identity-snapshot-port.js";

/** v4 快照身份块的默认夹具（legacy 视图：无 roster、空名牌）。 */
export function makeIdentity(
  overrides?: Partial<SnapshotIdentityState>,
): SnapshotIdentityState {
  return {
    identitySchemaVersion: SNAPSHOT_IDENTITY_SCHEMA_VERSION,
    dslProtocolVersion: 1,
    rosterScopeId: "legacy",
    rosterRevision: "legacy",
    characterLabels: {},
    cast: { allowedSpeakerIds: [], sceneParticipantIds: [] },
    ...overrides,
  };
}

export function makeSnapshot(overrides?: Partial<StateSnapshot>): StateSnapshot {
  return {
    snapshotVersion: 4,
    storyState: {
      scene: { id: "scene_1", location: "地下室", purpose: "发现旧终端" },
      characters: {},
      recent_summary: "林澈在废弃校舍发现了仍在运行的旧终端。",
    },
    visualState: { characters: {} },
    memoryDigest: {
      revision: 0,
      consolidatedThroughEventSeq: 0,
      checkpointCount: 0,
      threads: [],
      setups: [],
      anchors: [],
      facts: [],
      beliefs: [],
      consolidationFailedIntervals: [],
    },
    outlineRevision: 0,
    identity: makeIdentity(),
    ...overrides,
  };
}

export function makeForm(
  overrides?: Partial<InteractionFormSnapshot>,
): InteractionFormSnapshot {
  return { mode: "choice", prompt: "你要怎么做？", options: ["追问", "离开"], ...overrides };
}

export function makeDecision(
  overrides?: Partial<DecisionNode> & { id?: string },
): DecisionNode {
  const { id = "dc_001", ...rest } = overrides ?? {};
  return {
    id,
    sceneId: "sc_001",
    entryState: makeSnapshot(),
    form: makeForm(),
    ...rest,
  };
}

export function makeEdge(overrides?: Partial<PlotEdge> & { id?: string }): PlotEdge {
  const { id = "eg_001", ...rest } = overrides ?? {};
  return {
    id,
    from: "dc_001",
    choice: { kind: "option", text: "追问终端的来历" },
    payload: { eventCount: 0, firstSeq: 0, lastSeq: 0 },
    endState: makeSnapshot(),
    to: { kind: "decision", id: "dc_002" },
    ...rest,
  };
}
