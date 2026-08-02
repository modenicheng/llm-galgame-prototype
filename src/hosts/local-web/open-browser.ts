/**
 * openBrowser — launch the default browser for the local web host.
 *
 * Platform open commands: `cmd /c start` on win32, `open` on darwin,
 * `xdg-open` on linux. Never fails startup: errors are caught and the
 * caller logs and continues.
 */
import { spawn } from "node:child_process";

export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];

  const { promise, resolve } = Promise.withResolvers<void>();
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: platform !== "win32",
    windowsHide: true,
  });
  child.once("error", () => resolve());
  child.once("exit", () => resolve());
  child.unref();
  await promise;
}
