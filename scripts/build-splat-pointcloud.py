#!/usr/bin/env python3
"""
Bake a SuperSplat/PlayCanvas SOG (v2) Gaussian-splat scene into a tiny decimated point
cloud (positions + photoreal colors) for the kiosk point-cloud interaction.

WHY: the source scene (TUM Main Campus scan, superspl.at/scene/193ca7e8) is ~24.1M
splats / ~200MB of WebP-encoded SOG — impossible to ship to the kiosk. We only want a
stylised ~150k-point cloud that morphs/orbits in the existing shader, so we decode the
SOG offline and sample it down to a ~2MB binary the app loads directly.

SOG v2 layout (from meta.json):
  means:  16-bit per axis, low byte in means_l.webp + high byte in means_u.webp,
          linearly mapped into [mins, maxs].  (RGB = x,y,z)
  sh0:    RGB = 8-bit index into `sh0.codebook` → SH degree-0 coeff; colour = 0.5+SH_C0*dc.
          A   = per-splat OPACITY (linear 0-1) — used to drop floaters + fade faint points.
  scales: RGB = 8-bit index into `scales.codebook` (log-scales); world size = exp(mean).
          Used to size each point by the real splat footprint so big facades fill in.

QUALITY over a plain random sample: drop low-opacity floaters/haze, keep per-point opacity
and per-point size so surfaces read solid instead of a uniform dust.

INPUT (download once from the scene's public CloudFront, into <sog_dir>):
  meta.json, means_l.webp, means_u.webp, sh0.webp, scales.webp
    base: https://d28zzqy0iyovbz.cloudfront.net/193ca7e8/v1/

OUTPUT: <out>.bin  →  [uint32 count][float32 pos*3][uint8 rgba*4 (a=opacity)][float32 size*1]
Usage: python3 build-splat-pointcloud.py <sog_dir> <out.bin> [target_count] [opacity_min]
"""
import sys, json, struct
import numpy as np
from PIL import Image

SH_C0 = 0.28209479177387814  # SH degree-0 basis → converts DC coefficient to base colour


def main() -> None:
    sog_dir = sys.argv[1] if len(sys.argv) > 1 else "scratch/sog"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "tum-campus.bin"
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 150_000
    opacity_min = float(sys.argv[4]) if len(sys.argv) > 4 else 0.4  # drop floaters below this

    meta = json.load(open(f"{sog_dir}/meta.json"))
    count = meta["count"]
    mins = np.array(meta["means"]["mins"], dtype=np.float64)
    maxs = np.array(meta["means"]["maxs"], dtype=np.float64)
    cb_col = np.array(meta["sh0"]["codebook"], dtype=np.float32)
    cb_scale = np.array(meta["scales"]["codebook"], dtype=np.float32)
    print(f"count={count:,}  target={target:,}  opacity_min={opacity_min}")

    def load_rgba(name: str) -> np.ndarray:
        img = Image.open(f"{sog_dir}/{name}").convert("RGBA")
        a = np.asarray(img, dtype=np.uint8).reshape(-1, 4)  # row-major = splat index order
        return a[:count]  # trailing padding pixels beyond `count` are junk

    lo = load_rgba("means_l.webp")
    hi = load_rgba("means_u.webp")
    sh0 = load_rgba("sh0.webp")
    scl = load_rgba("scales.webp")

    # --- drop low-opacity floaters/haze (sh0 alpha = linear opacity) ---
    opacity = sh0[:, 3].astype(np.float32) / 255.0
    keep = np.where(opacity >= opacity_min)[0]
    print(f"kept {len(keep):,} of {count:,} after opacity>={opacity_min} "
          f"({100*len(keep)/count:.0f}%)")

    # --- uniform sample from the kept (opaque) splats ---
    rng = np.random.default_rng(42)  # fixed seed → reproducible bake
    idx = keep[rng.choice(len(keep), size=min(target, len(keep)), replace=False)]
    idx.sort()
    lo, hi, sh0, scl, opacity = lo[idx], hi[idx], sh0[idx], scl[idx], opacity[idx]

    # --- positions: 16-bit L/U → normalise → linear map into [mins, maxs] ---
    w16 = (hi[:, :3].astype(np.uint32) << 8) | lo[:, :3].astype(np.uint32)  # xyz
    pos = mins + (w16.astype(np.float64) / 65535.0) * (maxs - mins)

    # --- colours: sh0 RGB index → codebook DC → base colour ---
    rgb = np.clip(0.5 + SH_C0 * cb_col[sh0[:, :3]], 0.0, 1.0)
    rgba = np.concatenate([rgb, opacity[:, None]], axis=1)
    rgba8 = (rgba * 255.0 + 0.5).astype(np.uint8)

    # --- per-point size: real splat world footprint, normalised so median≈1 ---
    world = np.exp(cb_scale[scl[:, :3]]).mean(1)  # world-space size per splat
    size = world / np.median(world)
    size = np.clip(size, 0.3, 6.0).astype(np.float32)  # cap so a few huge splats don't blob

    m = len(idx)
    print(f"baked {m:,} points")
    print(f"  pos bounds  min={pos.min(0).round(2)}  max={pos.max(0).round(2)}")
    print(f"  colour mean={rgba8[:, :3].mean(0).round(1)}  size p50/p99={np.percentile(size,50):.2f}/{np.percentile(size,99):.2f}")

    with open(out_path, "wb") as f:
        f.write(struct.pack("<I", m))
        f.write(pos.astype("<f4").tobytes())
        f.write(rgba8.astype(np.uint8).tobytes())  # rgba, a = opacity
        f.write(size.astype("<f4").tobytes())
    print(f"wrote {out_path}  ({4 + m * 12 + m * 4 + m * 4:,} bytes)")


if __name__ == "__main__":
    main()
