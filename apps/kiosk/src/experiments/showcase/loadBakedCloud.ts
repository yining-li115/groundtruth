/**
 * Loads a baked point-cloud asset produced by scripts/build-splat-pointcloud.py.
 * Binary layout (little-endian):
 *   [uint32 count][float32 pos*3][uint8 rgba*4 (a=opacity)][float32 size*1]
 *
 * Decimated from a SuperSplat/PlayCanvas SOG Gaussian-splat scene offline (the raw scene
 * is ~24M splats / ~200MB — far too heavy for the kiosk). Floaters are dropped and each
 * point carries the source splat's opacity + world footprint so it reads as a surface,
 * not uniform dust. Feeds the morph shader as a particle system.
 */
export interface BakedCloud {
  count: number;
  positions: Float32Array; // xyz, model space
  rgba: Uint8Array; // rgba 0-255 (a = per-point opacity)
  sizes: Float32Array; // per-point size factor (splat footprint, median ≈ 1)
}

export async function loadBakedCloud(url: string): Promise<BakedCloud> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`baked cloud ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const count = new DataView(buf).getUint32(0, true);
  const positions = new Float32Array(buf, 4, count * 3);
  const rgba = new Uint8Array(buf, 4 + count * 12, count * 4);
  const sizes = new Float32Array(buf, 4 + count * 16, count);
  return { count, positions, rgba, sizes };
}
