# Hero showcase models

The GLB files in this folder are **not committed to git** (see root `.gitignore`) — they
are heavy binaries (~89 MB total) used only by the WIP hero experiment at
`/?exp=showcase` (`apps/kiosk/src/experiments/showcase/SceneModels.tsx`). The live home
hero does **not** use them; it runs on the procedural `Scene.tsx`.

We only **surface-sample points** off these models (via `sampleModels.ts`) — textures,
materials, normals and animations are discarded — so any roughly-correct mesh works.

## Expected files

Place these here for the experiment to run (filenames are referenced in `SceneModels.tsx`):

| File | What it is | Role in scene |
|------|------------|---------------|
| `tower_a.glb` | tall office tower | city skyline (center, tall) |
| `tower_b.glb` | mid-rise building | city skyline (center) |
| `building_low.glb` | low/wide building | city outskirts (Z-up source) |
| `car.glb` | sedan | ground-level acquisition prop |
| `satellite.glb` | Earth-observation satellite | two placed overhead |
| `drone.glb` | quadcopter | overhead acquisition prop |
| `tree.glb` | tree | organic accents (Z-up source) |

## Sources / attribution — TODO

Current models were pulled from Sketchfab. Before any public deploy, record each model's
**author + license + URL** here (CC-BY requires attribution). Prefer CC0 sources
(Kenney, Quaternius, NASA 3D) where possible.
