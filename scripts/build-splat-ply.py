#!/usr/bin/env python3
"""
Convert the SuperSplat/PlayCanvas SOG (v2) scene into a standard 3D Gaussian-Splatting
binary .ply (INRIA field layout) so a three.js splat renderer can show the REAL gaussians
(photoreal), decimated to a size the kiosk can render natively.

SOG v2 → .ply field mapping:
  means  (means_l/u.webp, 16-bit, linear mins..maxs)      → x, y, z
  sh0    RGB = idx into sh0.codebook (SH DC)               → f_dc_0..2   (color=0.5+SH_C0*dc)
  sh0    A   = linear opacity                              → opacity  (stored as LOGIT)
  scales RGB = idx into scales.codebook (log-scale)        → scale_0..2 (already log)
  quats  RGBA "smallest-three": A&3 = largest comp index,  → rot_0..3   (w,x,y,z)
         R,G,B = the other three in [-1/√2, 1/√2]

Usage: python3 build-splat-ply.py <sog_dir> <out.ply> [target_count] [opacity_min]
"""
import sys, json
import numpy as np
from PIL import Image

SH_C0 = 0.28209479177387814
INV_SQRT2 = 1.0 / np.sqrt(2.0)


def main() -> None:
    sog = sys.argv[1] if len(sys.argv) > 1 else "sog"
    out = sys.argv[2] if len(sys.argv) > 2 else "tum-campus.ply"
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 1_500_000
    opacity_min = float(sys.argv[4]) if len(sys.argv) > 4 else 0.2

    meta = json.load(open(f"{sog}/meta.json"))
    count = meta["count"]
    mins = np.array(meta["means"]["mins"]); maxs = np.array(meta["means"]["maxs"])
    cb_col = np.array(meta["sh0"]["codebook"], dtype=np.float32)
    cb_scale = np.array(meta["scales"]["codebook"], dtype=np.float32)

    def rgba(name):
        return np.asarray(Image.open(f"{sog}/{name}").convert("RGBA"), dtype=np.uint8).reshape(-1, 4)[:count]

    lo = rgba("means_l.webp"); hi = rgba("means_u.webp")
    sh0 = rgba("sh0.webp"); scl = rgba("scales.webp"); qt = rgba("quats.webp")

    opacity = sh0[:, 3].astype(np.float32) / 255.0
    keep = np.where(opacity >= opacity_min)[0]
    rng = np.random.default_rng(42)
    idx = keep[rng.choice(len(keep), size=min(target, len(keep)), replace=False)]
    idx.sort()
    lo, hi, sh0, scl, qt, opacity = lo[idx], hi[idx], sh0[idx], scl[idx], qt[idx], opacity[idx]
    n = len(idx)
    print(f"count={count:,}  kept>={opacity_min}: {len(keep):,}  baking {n:,}")

    # positions
    w16 = (hi[:, :3].astype(np.uint32) << 8) | lo[:, :3].astype(np.uint32)
    pos = (mins + (w16 / 65535.0) * (maxs - mins)).astype(np.float32)

    # colour DC + opacity(logit)
    fdc = cb_col[sh0[:, :3]].astype(np.float32)
    o = np.clip(opacity, 1e-4, 1 - 1e-4)
    op_logit = np.log(o / (1 - o)).astype(np.float32)

    # log-scales
    scale = cb_scale[scl[:, :3]].astype(np.float32)

    # quaternion: smallest-three → (x,y,z,w), then written as (w,x,y,z)
    mode = (qt[:, 3] & 3).astype(np.int64)
    abc = (qt[:, :3].astype(np.float32) / 255.0 - 0.5) * (2.0 * INV_SQRT2)  # three components
    largest = np.sqrt(np.clip(1.0 - (abc ** 2).sum(1), 0.0, 1.0))
    q = np.zeros((n, 4), dtype=np.float32)  # order x,y,z,w
    notmax = np.ones((n, 4), dtype=bool)
    notmax[np.arange(n), mode] = False
    q[notmax] = abc.reshape(-1)  # 3 non-largest slots per row (row-major) ← abc in order
    q[np.arange(n), mode] = largest
    # .ply rot order is (w,x,y,z)
    rot = np.stack([q[:, 3], q[:, 0], q[:, 1], q[:, 2]], axis=1)

    fields = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.zeros((n, len(fields)), dtype=np.float32)
    data[:, 0:3] = pos
    data[:, 3:6] = fdc
    data[:, 6] = op_logit
    data[:, 7:10] = scale
    data[:, 10:14] = rot

    header = ("ply\nformat binary_little_endian 1.0\n"
              f"element vertex {n}\n" +
              "".join(f"property float {f}\n" for f in fields) +
              "end_header\n").encode("ascii")
    with open(out, "wb") as f:
        f.write(header)
        f.write(data.tobytes())
    print(f"wrote {out}  ({len(header) + data.nbytes:,} bytes)")
    print(f"  pos bounds min={pos.min(0).round(2)} max={pos.max(0).round(2)}")
    print(f"  quat norm mean={np.linalg.norm(q,axis=1).mean():.3f} (should be ~1.0)")


if __name__ == "__main__":
    main()
