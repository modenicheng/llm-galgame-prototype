import { describe, expect, it, vi } from "vitest";
import { fetchAssetManifest } from "./asset-manifest-client.js";

it("成功时返回解析后的 manifest", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ backgrounds: { a: { url: "/x" } } }),
  }));
  const m = await fetchAssetManifest();
  expect(m?.backgrounds.a!.url).toBe("/x");
});

it("非 200 或异常时返回 null", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  expect(await fetchAssetManifest()).toBeNull();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
  expect(await fetchAssetManifest()).toBeNull();
});
