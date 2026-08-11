/**
 * Commands a driver (CLI controller, web host, tests) sends to the
 * runtime. The runtime never blocks on callbacks; it awaits commands at
 * well-defined interaction points and publishes RuntimeOutput events.
 */
export type RuntimeCommand =
  /** Kick off the run loop (accepted for lifecycle symmetry; run() starts automatically). */
  | { type: "start" }
  /** Continue playback past the currently presented line. */
  | { type: "advance" }
  /** Pick a preset option of an open interaction. */
  | {
      type: "select_choice";
      interactionId: string;
      optionId: string;
    }
  /** Freeze draft text and begin the input preview (first Enter). */
  | {
      type: "preview_input";
      interactionId: string;
      text: string;
    }
  /** Commit the previewed input (second Enter). */
  | {
      type: "confirm_input";
      previewId: string;
    }
  /** Abort the previewed input and return to editing (Esc). */
  | {
      type: "cancel_input";
      previewId: string;
    }
  /** Abort the whole run loop. */
  | { type: "shutdown" }
  /** 结束当前会话并重建运行时（新 session id、新开场）。 */
  | { type: "restart_session" };
