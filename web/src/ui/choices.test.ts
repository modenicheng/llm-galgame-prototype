/**
 * renderChoices regression — the Game converts mode:choice interactions into
 * a synthetic `choice` event with NO interaction_id (src/game.ts handleChoice).
 * The view model normalizes it with the top-level interactionId; renderChoices
 * (asChoiceInteraction) requires interaction_id to be a string, so without the
 * normalization the player would see an empty option list and the game would
 * appear frozen.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@shared/wire/server-message.js";
import { GameViewModel } from "../runtime/game-view-model.js";
import { renderChoices } from "./choices.js";

function syntheticChoiceOpened(interactionId: string): ServerMessage {
  return {
    type: "runtime.output",
    sequence: 10,
    output: {
      type: "interaction_opened",
      interactionId,
      interaction: {
        type: "choice",
        prompt: "你要怎么做？",
        options: [
          { id: "a", text: "跟上她" },
          { id: "b", text: "留在原地" },
        ],
      },
    },
  };
}

describe("renderChoices", () => {
  it("renders option buttons for a synthetic choice normalized by the view model", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(syntheticChoiceOpened("choice_2"));

    const container = document.createElement("div");
    renderChoices(container, vm.state().currentInteraction, () => {});

    const buttons = container.querySelectorAll("button.choice");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toBe("跟上她");
    expect(buttons[1]!.textContent).toBe("留在原地");
  });

  it("renders nothing for a raw synthetic choice without interaction_id (pre-normalization shape)", () => {
    const container = document.createElement("div");
    renderChoices(
      container,
      { type: "choice", prompt: "?", options: [{ id: "a", text: "A" }] },
      () => {},
    );
    expect(container.querySelectorAll("button.choice")).toHaveLength(0);
  });
});
