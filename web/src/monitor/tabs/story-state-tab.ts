/**
 * Story-state tab — the live StoryState projection: scene, characters,
 * open threads, canon facts, rolling recap, player profile.
 */
import type { MonitorStateFrame } from "@shared/wire/monitor-message.js";
import { el } from "../../ui/dom.js";

/** StoryState as it crosses the monitor wire (plain JSON). */
type StoryStateView = MonitorStateFrame["session"]["storyState"];

const THREAD_STATUS_LABELS: Record<string, string> = {
  new: "新",
  active: "活跃",
  ready: "待收束",
  resolved: "已解决",
  abandoned: "已放弃",
};

function kvCard(title: string, rows: [string, string][]): HTMLElement {
  const card = el("div", "kv-card");
  card.appendChild(el("h4", undefined, title));
  for (const [k, v] of rows) {
    const row = el("div", "row");
    row.appendChild(el("span", "k", k));
    const val = el("span", undefined);
    val.textContent = v.length > 0 ? v : "—";
    row.appendChild(val);
    card.appendChild(row);
  }
  return card;
}

export function renderStoryState(container: HTMLElement, state: StoryStateView | undefined): void {
  container.textContent = "";
  if (state === undefined) {
    container.appendChild(el("div", "mon-empty", "等待剧情状态…"));
    return;
  }

  container.appendChild(el("div", "section-title", "场景"));
  const grid = el("div", "kv-grid");
  grid.appendChild(
    kvCard("当前场景", [
      ["地点", state.scene.location],
      ["时间", state.scene.time ?? "—"],
      ["目的", state.scene.purpose],
    ]),
  );
  container.appendChild(grid);

  const characterIds = Object.keys(state.characters);
  if (characterIds.length > 0) {
    container.appendChild(el("div", "section-title", "角色"));
    const chars = el("div", "kv-grid");
    for (const id of characterIds) {
      const c = state.characters[id]!;
      chars.appendChild(
        kvCard(id, [
          ["情绪", c.emotion ?? "—"],
          ["位置", c.location ?? "—"],
          ["当前目标", c.current_goal ?? "—"],
          ["与玩家关系", c.relationship_to_player ?? "—"],
          ["已知事实", (c.known_facts ?? []).slice(-3).join("；")],
        ]),
      );
    }
    container.appendChild(chars);
  }

  container.appendChild(el("div", "section-title", "开放线索"));
  if (state.open_threads.length === 0) {
    container.appendChild(el("div", undefined, "（无）"));
  } else {
    const list = el("div", "thread-list");
    for (const thread of state.open_threads) {
      const item = el("div", "thread-item");
      const status = el("span", `thread-status st-${thread.status}`);
      status.textContent = THREAD_STATUS_LABELS[thread.status] ?? thread.status;
      item.appendChild(status);
      const summary = el("span", undefined);
      summary.textContent = `${thread.summary}（turn ${thread.last_touched_turn}）`;
      item.appendChild(summary);
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  container.appendChild(el("div", "section-title", "前情梗概 [Recap]"));
  const recap = el("pre", "mon-pre");
  recap.textContent = state.recent_summary.length > 0 ? state.recent_summary : "（尚无——滑窗未触发）";
  container.appendChild(recap);

  container.appendChild(el("div", "section-title", "世界设定 canon"));
  const canon = el("pre", "mon-pre");
  canon.textContent = JSON.stringify(state.canon, null, 2);
  container.appendChild(canon);

  container.appendChild(el("div", "section-title", "玩家画像"));
  const profile = el("div", undefined);
  profile.textContent =
    state.player_profile.recent_tendencies.length > 0
      ? state.player_profile.recent_tendencies.join(" · ")
      : "（暂无）";
  container.appendChild(profile);
}
