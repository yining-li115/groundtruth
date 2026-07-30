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
| `tum-campus.ply` | ~1.8M Gaussians, cropped to the Hauptgebäude, rotated upright | source for the web build | no (git-ignored) |
| `tum-campus-web.ply` | **400k** decimated, **no SH** (~21MB) — the mkkellogg-era campus | showreel landing (`SplatStage`), `/?exp=splatnav`, `/?exp=splat3d` | **yes (committed)** |
| `tum-campus.sog` | **1.8M**, same crop, ~21MB — same download as the 400k PLY, 4.5x the splats | the showreel flight, `/?exp=spark` | **yes (committed)** |
| `tum-campus-full.sog` | **12.4M**, full source density, ~147MB | `/?exp=spark&asset=max` | no (git-ignored) |
| `tum-campus.bin` | ~500k decimated points (pos + rgba + size) | `/?exp=cv` and the old point-cloud showreel | no (git-ignored) |

The `.sog` tiers are read by **Spark** (`@sparkjsdev/spark`), which mkkellogg's renderer
cannot open. SOG is a WebP bundle, so the full 1.8M crop costs the same download as the
400k PLY it replaces — which is why that tier is committed and the deployed showreel flies
through it.

The 12.4M tier is the one that actually holds up a couple of metres from a façade, but 147MB
cannot go in git history and would be re-fetched on every cold load. Putting it on object
storage (R2/B2) and pointing `URLS.max` at an absolute URL is the way to ship it; until then
the deployed site runs the 1.8M tier.

`tum-campus-web.ply` is committed (via a `!` exception in `.gitignore`) so the deployed
landing page has its Gaussian campus without hosting the full 97MB scan. Rebuild it from
the full `.ply`:

```
npx @playcanvas/splat-transform tum-campus.ply -H 0 -d 400000 tum-campus-web.ply -w
```

## Regenerate

Needs the SOG WebP files above in a local `sog/` dir, `@playcanvas/splat-transform`
(via `npx`), and Python (`numpy`, `Pillow`).

1. **Campus crop** — decode the source SOG, rotate upright, cut to the school block. One
   command, no helper script:
   ```
   # full density (12.4M) — what /?exp=spark&asset=max loads
   npx @playcanvas/splat-transform sog/meta.json -N -r 0,20.9,0 \
     -B -26,-50,-35,23,50,26 tum-campus-full.sog -w

   # 1.8M tier — same crop, decimated (decimate must be last and output .ply, so 2 passes)
   npx @playcanvas/splat-transform sog/meta.json -N -r 0,20.9,0 \
     -B -26,-50,-35,23,50,26 -d 1800000 tum-campus.ply -w
   npx @playcanvas/splat-transform tum-campus.ply tum-campus.sog -w
   ```

   Two things this file used to get wrong, both of which silently produce a broken model:

   - **The upright yaw is 20.9°, not 16.9°.** At 16.9° the crop box sits 4° off the
     buildings and shears a diagonal corner off the campus. 20.9° was recovered by
     correlating top-down height maps of the source against the tuned crop — a sharp peak
     (corr 0.998 at 20.9°, 0.96 at ±1°, 0.70 at ±5°).
   - **Do not clamp Y in the crop box.** The old box `-26,-8,-35,23,7,26` cut the top 2.77
     units off the site — the clock tower's spire flattens into a dark stump. Use ±50 (i.e.
     no vertical limit); it costs ~1M extra splats.

   (Reference: `scripts/build-splat-ply.py` decodes SOG directly; splat-transform is the
   authoritative decoder used for the shipped assets.)

2. **Point-cloud `.bin`** from the cropped `.ply`:
   ```
   python3 scripts/build-pointcloud-from-ply.py \
     apps/kiosk/public/splat/tum-campus.ply \
     apps/kiosk/public/splat/tum-campus.bin 500000 0.25
   ```
