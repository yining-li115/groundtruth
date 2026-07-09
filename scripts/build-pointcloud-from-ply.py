#!/usr/bin/env python3
"""
Extract a decimated particle point cloud from the cropped/upright 3DGS .ply (the TUM
Hauptgebäude) for the hand-gesture disperse/reassemble interaction (/?exp=cv).

Each Gaussian's CENTRE is a point; we keep its colour, opacity and footprint so the
assembled cloud reads like the building. This is the "extract point cloud from the 3dgs"
step, now from the good cropped data (real metres, real colours) instead of the earlier
log-space SOG decode.

.ply fields → point:  x,y,z → position ; f_dc → colour (0.5+SH_C0·dc) ;
  opacity(logit) → sigmoid → per-point alpha ; scale(log) → exp → per-point size.

OUTPUT (matches loadBakedCloud.ts): [uint32 count][f32 pos*3][u8 rgba*4][f32 size*1]
Usage: python3 build-pointcloud-from-ply.py <in.ply> <out.bin> [target_count] [opacity_min]
"""
import sys, struct
import numpy as np

SH_C0 = 0.28209479177387814


def main() -> None:
    inp = sys.argv[1]
    out = sys.argv[2]
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 500_000
    opacity_min = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25

    f = open(inp, "rb")
    hdr = b""
    while b"end_header\n" not in hdr:
        hdr += f.read(1)
    lines = hdr.decode().splitlines()
    n = int([l for l in lines if l.startswith("element vertex")][0].split()[-1])
    names = [l.split()[-1] for l in lines if l.startswith("property float")]
    d = np.frombuffer(f.read(n * len(names) * 4), dtype="<f4").reshape(n, len(names))

    def col(name):
        return d[:, names.index(name)]

    pos = np.stack([col("x"), col("y"), col("z")], axis=1)
    rgb = np.clip(0.5 + SH_C0 * np.stack([col("f_dc_0"), col("f_dc_1"), col("f_dc_2")], 1), 0, 1)
    opacity = 1.0 / (1.0 + np.exp(-col("opacity")))  # logit → linear
    world = np.exp(np.stack([col("scale_0"), col("scale_1"), col("scale_2")], 1)).mean(1)

    keep = np.where(opacity >= opacity_min)[0]
    rng = np.random.default_rng(42)
    idx = keep[rng.choice(len(keep), size=min(target, len(keep)), replace=False)]
    idx.sort()
    pos, rgb, opacity, world = pos[idx], rgb[idx], opacity[idx], world[idx]
    m = len(idx)

    rgba8 = np.concatenate([rgb, opacity[:, None]], axis=1)
    rgba8 = (rgba8 * 255.0 + 0.5).astype(np.uint8)
    size = np.clip(world / np.median(world), 0.3, 6.0).astype(np.float32)

    print(f"in {n:,} gaussians → kept {len(keep):,} (opacity>={opacity_min}) → baked {m:,} points")
    print(f"  pos bounds min={pos.min(0).round(1)} max={pos.max(0).round(1)}")
    with open(out, "wb") as g:
        g.write(struct.pack("<I", m))
        g.write(pos.astype("<f4").tobytes())
        g.write(rgba8.astype(np.uint8).tobytes())
        g.write(size.astype("<f4").tobytes())
    print(f"wrote {out}  ({4 + m * 12 + m * 4 + m * 4:,} bytes)")


if __name__ == "__main__":
    main()
