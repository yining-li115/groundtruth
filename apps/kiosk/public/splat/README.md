# Point-cloud / Gaussian-splat assets (regenerated, not in git)

The heavy binaries here are **git-ignored** (like the GLB models) and rebuilt from the
source scene by the scripts in `/scripts`. Only this manifest is committed.

## Source

TUM Main Campus (Hauptgebäude) 3D Gaussian-splat scan, published on SuperSplat:
- scene: https://superspl.at/scene/193ca7e8
- public SOG data (WebP): `https://d28zzqy0iyovbz.cloudfront.net/193ca7e8/v1/`
  (`meta.json`, `means_l.webp`, `means_u.webp`, `sh0.webp`, `scales.webp`, `quats.webp`)

## Files

| File | What | Used by |
|------|------|---------|
| `tum-campus.ply` | ~1.9M Gaussians, cropped to the Hauptgebäude, rotated upright | `/?exp=splat3d` (native splat) |
| `tum-campus.bin` | ~500k decimated points (pos + rgba + size) | `/?exp=cv` and the idle showreel |

## Regenerate

Needs the SOG WebP files above in a local `sog/` dir, `@playcanvas/splat-transform`
(via `npx`), and Python (`numpy`, `Pillow`).

1. **Splat `.ply`** — decode SOG → decimate → crop (real metres) → rotate upright:
   ```
   npx @playcanvas/splat-transform sog/meta.json -N -H 0 -F 3000000 full.ply -w
   # crop to the school block + rotate +16.9° upright (see git history for the exact box);
   # scripts/crop helper produces tum-campus.ply
   ```
   (Reference: `scripts/build-splat-ply.py` decodes SOG directly; splat-transform is the
   authoritative decoder used for the shipped asset.)

2. **Point-cloud `.bin`** from the cropped `.ply`:
   ```
   python3 scripts/build-pointcloud-from-ply.py \
     apps/kiosk/public/splat/tum-campus.ply \
     apps/kiosk/public/splat/tum-campus.bin 500000 0.25
   ```
