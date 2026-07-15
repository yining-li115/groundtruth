# Point-cloud / Gaussian-splat assets (regenerated, not in git)

The heavy binaries here are **git-ignored** (like the GLB models) and rebuilt from the
source scene by the scripts in `/scripts`. Only this manifest is committed.

## Source

TUM Main Campus (Hauptgebäude) 3D Gaussian-splat scan, published on SuperSplat:
- scene: https://superspl.at/scene/193ca7e8
- public SOG data (WebP): `https://d28zzqy0iyovbz.cloudfront.net/193ca7e8/v1/`
  (`meta.json`, `means_l.webp`, `means_u.webp`, `sh0.webp`, `scales.webp`, `quats.webp`)

## Files

| File | What | Used by | In git? |
|------|------|---------|---------|
| `tum-campus.ply` | ~1.9M Gaussians, cropped to the Hauptgebäude, rotated upright | source for the web build | no (git-ignored) |
| `tum-campus-web.ply` | **400k** decimated, **no SH** (~21MB) — the shipped campus | showreel landing (`SplatStage`), `/?exp=splatnav`, `/?exp=splat3d` | **yes (committed)** |
| `tum-campus.bin` | ~500k decimated points (pos + rgba + size) | `/?exp=cv` and the old point-cloud showreel | no (git-ignored) |

`tum-campus-web.ply` is committed (via a `!` exception in `.gitignore`) so the deployed
landing page has its Gaussian campus without hosting the full 97MB scan. Rebuild it from
the full `.ply`:

```
npx @playcanvas/splat-transform tum-campus.ply -H 0 -d 400000 tum-campus-web.ply -w
```

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
