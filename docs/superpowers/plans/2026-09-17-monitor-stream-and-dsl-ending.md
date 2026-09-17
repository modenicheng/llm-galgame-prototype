# Monitor Stream and DSL Ending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DSL endings resilient to a bounded set of unambiguous terminal-keyword mistakes and turn the writer monitor into one request-aware, auto-scrolling document with semantic event styling and current-player-line highlighting.

**Architecture:** Keep `@end` as the strict protocol boundary, with a small pure normalizer and parser-assisted form closure for only well-defined terminal mistakes. Carry request telemetry and optional DSL source locations through the existing observer and monitor wire; `Game` keeps ephemeral source maps and exposes the current location. The browser renders every retained attempt chronologically in one document and updates individual sections incrementally.

**Tech Stack:** TypeScript, Vitest, happy-dom, OpenAI-compatible streaming API, DOM/CSS without a UI framework.

**Spec:** `docs/superpowers/specs/2026-09-17-monitor-stream-and-dsl-ending-design.md`

**Execution status (2026-09-17):** Implemented. Focused suite: 163/163 passed; typecheck and production build passed. Full suite: 1635/1636 passed, with the same pre-existing `src/config.test.ts` / `prompts/author.yaml` preferred-phrase mismatch recorded before implementation.

**Acceptance (2026-09-17 晚):** 三路无上下文子代理独立审查（DSL 收尾链路 / 监控服务端 / 监控前端）后修复全部 P1/P2 及可修 P3：新增 `FORM_OPEN_AT_SENTINEL`（buffer/ending 哨兵遇未闭合表单 fail-loud）、abort/硬失败补发 `onAttemptEnd`（新增 `cancelled` 终态）、ring 淘汰与重启清空补终态事件、观察者安全包装、自动跟随不再被程序化滚动关掉、高亮清理改增量、估算 input 非零、`@+/@=` 行不跑 visual_swap 修复。新增 7 项回归测试；全量 1656/1657（唯一失败为既有 author.yaml 断言）。真机浏览器验收：连续文档/边界遥测/失败注记/当前行高亮/图标化底栏/事件分层样式均与规格一致。遗留（非本次范围）：模型连续 3 局在开场尾部输出裸 `@?` 触发 EMPTY_FORM_PROMPT 后 run loop 静默退出、Game 级修复续写未触发（属已知 run-loop 脆弱类问题）。

## Global Constraints

- The formal terminal remains `@end <nonce> <reason>`; never infer nonce or reason.
- Repair only known whole-line `end` keyword manglings that still carry the exact expected nonce and an allowed reason, plus valid open forms followed by an `interaction` sentinel.
- Every repair is observable; no silent correction.
- No new runtime dependencies and no persisted DSL provenance.
- Preserve the writer ring limit of 12 tasks and current text caps.
- Existing uncommitted work is authoritative; edit only files named by this plan and do not reset unrelated changes.
- Follow red-green-refactor for every behavior change.

---

### Task 1: Lock the prompt ending contract

**Files:**
- Modify: `prompts/dsl-protocol.txt`
- Modify: `prompts/instructions.yaml`
- Test: `src/prompts.test.ts`

**Interfaces:**
- Consumes: existing `{nonce}` and task template interpolation.
- Produces: prompt text whose interaction tail contains `@/?\n@end {nonce} interaction` and whose non-interaction tasks show their exact allowed terminal before prose requirements.

- [ ] **Step 1: Add failing prompt assertions**

Add focused expectations to `src/prompts.test.ts` that the protocol contains the three-step tail checklist and that `opening`, `continuation`, `branch_prefetch`, `input_response`, `input_bridge`, and `ending` contain their exact terminal template. For interaction-capable templates, assert the adjacent literal sequence:

```ts
expect(instructions.opening).toContain("@/?\n@end {nonce} interaction");
expect(instructions.continuation).toContain("@end {nonce} buffer");
expect(instructions.ending).toContain("@end {nonce} ending");
```

- [ ] **Step 2: Run the prompt test and verify red**

Run: `pnpm test -- src/prompts.test.ts`

Expected: FAIL because the exact fixed-tail wording and adjacency are not present.

- [ ] **Step 3: Rewrite the ending guidance**

Move the short tail contract next to the form grammar in `dsl-protocol.txt`, retain the authoritative grammar section, and replace repeated warnings with the exact templates. In `instructions.yaml`, place an `本次固定尾部` block before each task's body requirements, using only the reasons allowed by that task.

- [ ] **Step 4: Run the prompt test and verify green**

Run: `pnpm test -- src/prompts.test.ts`

Expected: PASS.

### Task 2: Implement narrow terminal repair and repair observability

**Files:**
- Create: `src/core/protocol/gal-dsl/closing-repair.ts`
- Create: `src/core/protocol/gal-dsl/closing-repair.test.ts`
- Modify: `src/core/protocol/gal-dsl/group-builder.ts`
- Modify: `src/core/protocol/gal-dsl/segment-validator.ts`
- Modify: `src/core/protocol/gal-dsl/segment-validator.test.ts`
- Modify: `src/adapters/llm/openai-compatible-generator.ts`
- Modify: `src/llm.test.ts`
- Modify: `src/core/ports/dsl-stream-observer.ts`

**Interfaces:**
- Produces:

```ts
export interface DslClosingRepair {
  line: string;
  kind: "end_keyword";
}

export function repairDslClosingLine(
  raw: string,
  expectedNonce: string,
  allowedReasons: readonly SegmentEndReason[],
): DslClosingRepair | null;
```

- Produces `EventGroupBuilder.hasOpenInteraction(): boolean` and `DslSegmentParser.closeOpenInteraction(): EventGroupDraft[]`.
- Produces observer hook:

```ts
onRepair(
  attemptId: string,
  repair: { kind: "end_keyword" | "form_close"; lineIndex: number; message: string },
): void;
```

- [ ] **Step 1: Write failing pure repair tests**

Cover the accepted input `@ 07b8 interaction` and reject wrong nonce, disallowed reason, trailing content, `end 07b8 interaction`, and ordinary `@` narration.

- [ ] **Step 2: Run the repair test and verify red**

Run: `pnpm test -- src/core/protocol/gal-dsl/closing-repair.test.ts`

Expected: FAIL because `repairDslClosingLine` does not exist.

- [ ] **Step 3: Implement the exact repair function**

Use one anchored expression and equality checks; return the normalized `@end` line only when all constraints pass.

- [ ] **Step 4: Run the repair test and verify green**

Run: `pnpm test -- src/core/protocol/gal-dsl/closing-repair.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing parser tests for form closure**

Add cases proving a valid open form can be closed immediately before an `interaction` sentinel, while an empty/invalid form and a `buffer` sentinel cannot be repaired.

- [ ] **Step 6: Run parser tests and verify red**

Run: `pnpm test -- src/core/protocol/gal-dsl/segment-validator.test.ts`

Expected: FAIL because the parser exposes no guarded closure API.

- [ ] **Step 7: Implement guarded form closure**

Expose the builder's open state and add a parser method that pushes `{ kind: "form_end" }`. The generator calls it only when the parsed terminal reason is `interaction`; errors from `InteractionBuilder.finish()` propagate unchanged.

- [ ] **Step 8: Write failing generator observer tests**

Add one streamed response ending in `@ 07b8 interaction` with no `@/?`. Assert one interaction group, a complete interaction segment, and both repair observer events in source order. Add rejection coverage for a mismatched nonce.

- [ ] **Step 9: Run the generator tests and verify red**

Run: `pnpm test -- src/llm.test.ts`

Expected: FAIL because the adapter does not normalize terminal lines or emit repairs.

- [ ] **Step 10: Integrate the repair path**

Before `parseDslLine`, try the strict parse first and only fall back to `repairDslClosingLine` after a strict parse rejection. Track the `?` start line so a repaired interaction group keeps the prompt's source location. Emit `onRepair` for keyword repair and synthetic form closure.

- [ ] **Step 11: Run focused DSL tests**

Run: `pnpm test -- src/core/protocol/gal-dsl/closing-repair.test.ts src/core/protocol/gal-dsl/segment-validator.test.ts src/llm.test.ts`

Expected: PASS.

### Task 3: Carry request telemetry and DSL source locations through the monitor

**Files:**
- Modify: `src/core/protocol/gal-dsl/types.ts`
- Modify: `src/core/ports/dsl-stream-observer.ts`
- Modify: `src/adapters/llm/openai-compatible-generator.ts`
- Modify: `src/shared/wire/monitor-message.ts`
- Modify: `src/application/monitor/monitor-hub.ts`
- Modify: `src/application/monitor/monitor-hub.test.ts`
- Modify: `web/src/monitor/monitor-model.ts`
- Modify: `web/src/monitor/dsl-stream-view.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DslSourceLocation {
  attemptId: string;
  lineIndex: number;
}

export interface WriterAttemptUsage {
  input: number;
  output: number;
  cachedInput: number;
  source: "api" | "estimated";
  latencyMs: number;
  firstTokenMs: number | null;
}
```

- `EventGroupDraft.source?: DslSourceLocation` is optional for tests and non-stream producers.
- `DslStreamObserver.onUsage(attemptId, usage)` sends request-level usage before attempt end.
- `MonitorWriterAttempt` gains `usage: WriterAttemptUsage | null` and `repairs: MonitorWriterRepair[]`.

- [ ] **Step 1: Add failing MonitorHub lifecycle tests**

Feed `onUsage` and `onRepair`, then assert both snapshot fields and batched `monitor.event` payloads preserve exact values.

- [ ] **Step 2: Run the hub tests and verify red**

Run: `pnpm test -- src/application/monitor/monitor-hub.test.ts`

Expected: type or assertion failures because usage and repairs are absent.

- [ ] **Step 3: Extend observer, wire, hub, and client model types**

Store telemetry and repairs on each attempt, serialize them in snapshots, emit `writer.usage` and `writer.repair`, and fold those messages into `MonitorModel` without triggering a whole-document rebuild for every delta.

- [ ] **Step 4: Attach source locations in the generator**

When emitting a group, copy it with `source: { attemptId, lineIndex }`. Dialogue/narration/beat use the current main line; interactions use the remembered `form_start` line. Emit usage for API-reported and estimated paths with the measured latency fields.

- [ ] **Step 5: Run hub, model-flow, and generator tests**

Run: `pnpm test -- src/application/monitor/monitor-hub.test.ts web/src/monitor/dsl-stream-view.test.ts src/llm.test.ts`

Expected: PASS.

### Task 4: Expose the player's current DSL location

**Files:**
- Modify: `src/core/runtime/monitor-state.ts`
- Modify: `src/game.ts`
- Modify: `src/game.test.ts`
- Modify: `src/application/monitor/monitor-hub.test.ts`
- Modify: `web/src/monitor/monitor-model.ts`

**Interfaces:**
- Consumes: optional `EventGroupDraft.source` from Task 3.
- Produces: `GameMonitorState.currentDsl: DslSourceLocation | null`.
- Keeps private session maps from playable `line_id` and interaction id to source location; does not serialize them into session storage.

- [ ] **Step 1: Add failing game monitor tests**

Create sourced dialogue and interaction groups through the existing fake generator. Assert `getMonitorState().currentDsl` equals the dialogue source while `playback_ready` waits for advance and equals the form-start source while `interaction_opened` waits for input.

- [ ] **Step 2: Run focused game tests and verify red**

Run: `pnpm test -- src/game.test.ts`

Expected: FAIL because `currentDsl` is not exposed.

- [ ] **Step 3: Implement ephemeral source maps**

Register source locations inside `compileGroup`, set the current location immediately before emitting playback or interaction output, and return `null` for restored/legacy events without provenance. Clear the maps on session restore/reset paths.

- [ ] **Step 4: Update empty state fixtures and run tests**

Run: `pnpm test -- src/game.test.ts src/application/monitor/monitor-hub.test.ts`

Expected: PASS with `currentDsl: null` in empty states.

### Task 5: Replace per-attempt switching with one continuous DSL document

**Files:**
- Modify: `web/src/monitor/writer-panel.ts`
- Modify: `web/src/monitor/dsl-stream-view.ts`
- Modify: `web/src/monitor/dsl-stream-view.test.ts`
- Modify: `web/src/monitor/boot.ts`
- Modify: `web/src/monitor/monitor.css`

**Interfaces:**
- Consumes: chronological writer attempts, `writer.delta`, `writer.line`, `writer.usage`, `writer.repair`, `writer.end`, and `state.session.currentDsl`.
- Produces: one `.writer-document`, one `.writer-request` per attempt, `.writer-boundary` metadata, and `.dsl-row.is-current-player` on the active source location.

- [ ] **Step 1: Replace old DOM expectations with failing continuous-document tests**

Test that two tasks and a retry all remain visible at once in oldest-to-newest order, later deltas append only to their request, boundary text includes token/line/group/duration/end data, and no task-selection chips exist.

- [ ] **Step 2: Add failing current-location tests**

Apply a state frame with `{ attemptId, lineIndex }` and assert the matching row gains `is-current-player` plus an accessible label. For a `form_start`, assert the full form block through `form_end` gains the active block class.

- [ ] **Step 3: Run DOM tests and verify red**

Run: `pnpm test -- web/src/monitor/dsl-stream-view.test.ts`

Expected: FAIL because the panel renders only one selected attempt.

- [ ] **Step 4: Refactor the stream view into per-request sections**

Let each `DslStreamView` own only its rows while the writer panel owns the shared scroll host and pinned state. Expose `highlight(lineIndex)` and `rowKind(lineIndex)` so the panel can extend interaction highlighting from `form_start` through `form_end`.

- [ ] **Step 5: Build and incrementally update the continuous document**

Create all retained attempts on snapshot in chronological order. Create a request section on `writer.start`; route deltas and parse verdicts by attempt id; update boundary metadata on usage, repair, and end. Rebuild only for a new snapshot or ring eviction.

- [ ] **Step 6: Implement auto-follow and current-line priority**

Keep following while the scroll host is within 32 px of the bottom. When the current DSL location changes, scroll its row into view if following; otherwise preserve the operator's scroll position. Respect `prefers-reduced-motion` and use non-animated scrolling.

- [ ] **Step 7: Apply the focused visual system**

Use the spec palette. Keep ordinary rows flat and quiet; give request boundaries a structural rule, current player rows a blue left rail and label, repairs/retries amber treatment, errors red, and ending boundaries green. Remove task/attempt selection styles that are no longer used.

- [ ] **Step 8: Run DOM tests and typecheck**

Run: `pnpm test -- web/src/monitor/dsl-stream-view.test.ts web/src/monitor/dsl-tokens.test.ts`

Run: `pnpm typecheck`

Expected: both commands PASS.

### Task 6: Give the event panel frequency-aware semantic styling

**Files:**
- Modify: `web/src/monitor/tabs/logs-tab.ts`
- Create: `web/src/monitor/tabs/logs-tab.test.ts`
- Modify: `web/src/monitor/monitor.css`

**Interfaces:**
- Produces event rows with `event-row event-<kind>` and one of `event-routine`, `event-interactive`, or `event-terminal`.

- [ ] **Step 1: Write failing semantic-class tests**

Render narration, dialogue, interaction, player choice/input/dialogue, and end entries. Assert routine rows have no strong pill class, interactive rows have `event-interactive`, and the ending has `event-terminal`.

- [ ] **Step 2: Run the event tab test and verify red**

Run: `pnpm test -- web/src/monitor/tabs/logs-tab.test.ts`

Expected: FAIL because all events currently use `.log-row`.

- [ ] **Step 3: Implement semantic event markup and CSS**

Keep narration/dialogue compact with muted markers; use blue/amber rails and explicit player labels for interactive events; use a green terminal surface for ending. Keep diagnostics on the existing `.log-row` rules.

- [ ] **Step 4: Run event and monitor DOM tests**

Run: `pnpm test -- web/src/monitor/tabs/logs-tab.test.ts web/src/monitor/dsl-stream-view.test.ts`

Expected: PASS.

### Task 7: Documentation and full verification

**Files:**
- Modify: `docs/monitor-dashboard.md`

**Interfaces:**
- Documents the final wire data, repair limits, continuous document, event hierarchy, and current-player marker.

- [ ] **Step 1: Update the monitor documentation**

Replace the task-chip description with the continuous-document behavior, document request telemetry and repair annotations, and state that current-line provenance is live-session-only.

- [ ] **Step 2: Run the focused monitor and DSL suites**

Run: `pnpm test -- src/core/protocol/gal-dsl/closing-repair.test.ts src/core/protocol/gal-dsl/segment-validator.test.ts src/llm.test.ts src/application/monitor/monitor-hub.test.ts src/game.test.ts web/src/monitor/dsl-stream-view.test.ts web/src/monitor/dsl-tokens.test.ts web/src/monitor/tabs/logs-tab.test.ts`

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run the complete verification gates**

Run: `pnpm test`

Run: `pnpm typecheck`

Run: `pnpm build`

Expected: every command exits 0.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only the task's files plus pre-existing user changes are listed.

### Task 8: Distinguish request wait from active generation in the status bar

**Files:**
- Modify: `src/shared/wire/monitor-message.ts`
- Modify: `src/application/monitor/monitor-hub.ts`
- Modify: `src/application/monitor/monitor-hub.test.ts`
- Modify: `web/src/monitor/monitor-model.ts`
- Modify: `web/src/monitor/status-bar.ts`
- Create: `web/src/monitor/status-bar.test.ts`
- Modify: `web/src/monitor/monitor.css`

**Interfaces:**
- `MonitorWriterAttempt.firstTokenMs: number | null` is set by the hub on the first writer delta.
- `StatusBar` derives `requesting`, `streaming`, or `idle` from the newest active attempt and refreshes the live wait duration while requesting.

- [ ] **Step 1: Add failing hub and status-bar tests**

Assert `firstTokenMs` is null after start, is fixed on the first delta, and does not change on later deltas. Render the bar for a zero-character active attempt, a post-first-token active attempt, and no active attempt; assert the labels `请求中`, `生成中`, and `空闲` plus the relevant latency text.

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm test -- src/application/monitor/monitor-hub.test.ts web/src/monitor/status-bar.test.ts`

Expected: FAIL because first-token timing and three-state rendering do not exist.

- [ ] **Step 3: Record first-token timing and render the three states**

Set `firstTokenMs` exactly once in `MonitorHub.onDelta`, carry it through snapshots and the client model, and add a short-lived 250 ms status-bar ticker only while an attempt is waiting for its first token. Stop the ticker on the first delta, end, or disposal.

- [ ] **Step 4: Run status-bar tests and verification gates**

Run: `pnpm test -- src/application/monitor/monitor-hub.test.ts web/src/monitor/status-bar.test.ts`

Run: `pnpm typecheck`

Expected: PASS.
