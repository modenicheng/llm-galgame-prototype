import type { PublicAssetManifest } from "./stage-types.js";

/** 启动时请求一次；任何失败返回 null（渲染器回退占位，spec §6.1）。 */
export async function fetchAssetManifest(): Promise<PublicAssetManifest | null> {
  try {
    const res = await fetch("/api/assets/manifest");
    if (!res.ok) return null;
    return (await res.json()) as PublicAssetManifest;
  } catch {
    return null;
  }
}
