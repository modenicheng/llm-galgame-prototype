/**
 * Tiny DOM helpers shared by the UI widgets. Nothing here touches game or
 * audio state — pure presentation plumbing.
 */

/** Create an element with optional class list and text content. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Toggle the `hidden` attribute (visibility only — layout is CSS's job). */
export function show(node: HTMLElement | null, visible: boolean): void {
  if (node === null) return;
  node.hidden = !visible;
}

export function setText(node: HTMLElement | null, text: string): void {
  if (node !== null) node.textContent = text;
}

export function clearChildren(node: HTMLElement): void {
  while (node.firstChild !== null) {
    node.removeChild(node.firstChild);
  }
}

/** Narrow an unknown wire object to a plain record, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
