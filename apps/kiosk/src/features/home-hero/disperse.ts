import * as THREE from "three";

/**
 * Per-splat DISPERSE for a @mkkellogg/gaussian-splats-3d SplatMesh — makes the actual
 * gaussians scatter apart (and reassemble), the "particle explosion" the baked point cloud
 * does, but on the real 3DGS render.
 *
 * HOW: the library packs every splat's center into a GPU texture and its vertex shader
 * extracts it as `vec3 splatCenter = uintBitsToFloat(...)` (build/gaussian-splats-3d.module.js
 * ~L7626). We string-patch that ShaderMaterial to push each `splatCenter` outward along a
 * per-splat pseudo-random direction, scaled by a `uDisperse` uniform (0 = intact, 1 = fully
 * scattered). Everything downstream (view/clip/SH) already flows from `splatCenter`, so no
 * other change is needed.
 *
 * WHY THIS IS CHEAP: it's a GPU-only vertex offset (no rewriting the centers texture, no CPU
 * work). We deliberately DON'T re-sort while dispersing — as the gaussians spread they stop
 * overlapping, so out-of-order alpha blending is invisible; skipping the per-frame sort is
 * exactly what keeps this affordable. On reassemble (uDisperse→0) the original sort is exact
 * again.
 */

const CENTER_ANCHOR = "vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));";
const DECL_ANCHOR = "attribute uint splatIndex;";

const DECLS = /* glsl */ `
uniform float uDisperse;    // 0 = assembled, 1 = fully scattered
uniform float uDisperseAmp; // scatter box HALF-size in scan world-units
uniform vec3  uDisperseCenter; // scatter box center (roughly the look-at)

// Dave-Hoskins hash33 — FLOAT-only (no sin, no uint/hex, so no driver-specific compile issues),
// and it stays uniform for LARGE inputs: fract(n*k) folds the magnitude back into [0,1) FIRST,
// so millions-scale splatIndex hashes cleanly. (fract(sin(bigNumber)) degenerates on the GPU and
// made high-index splats clump into a local blob — this is the fix for the "local scatter".)
vec3 gtHash3(float n){
  vec3 p3 = fract(vec3(n) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}`;

// MORPH-TO-RANDOM (same model as the baked point-cloud disperse): every splat lerps toward its
// OWN independent, uniformly-random point in a box of half-size `amp` around the center. Target
// is independent of original position, so walls and courtyard dissolve identically into one
// frame-filling particle cloud. Linear in `uDisperse` = snappy.
const DISPLACE = /* glsl */ `
  // --- gaussian disperse (injected): morph every splat to an independent random point ---
  if (uDisperse > 0.0) {
    vec3 rnd = gtHash3(float(splatIndex));
    vec3 randTarget = uDisperseCenter + (rnd * 2.0 - 1.0) * uDisperseAmp;
    splatCenter = mix(splatCenter, randTarget, uDisperse);
  }`;

export interface DisperseHandle {
  /** set 0 (assembled) … 1 (scattered) each frame */
  uniform: { value: number };
  /** scatter distance (world units) — live-tunable */
  amp: { value: number };
}

/* ------------------------------------------------------------------------------------ */
/* DIRECTIONAL variant — the home hero's scroll disperse. Same morph-to-random model as the
 * showreel patch above (each splat lerps to its OWN uniformly-random point in a box, which
 * is what makes the dust fill the whole frame instead of a drifting blob), but the box is
 * expressed in SCREEN axes (right/up/forward uniforms fed from the live camera) and its
 * centre is shifted toward screen-right — so the net motion still reads "blown to the
 * right" like the old point-cloud hero. Staggered per splat with the same
 * `(p - rand*0.25)/0.75` + smoothstep ramp the baked point cloud used. */

const DIR_DECLS = /* glsl */ `
uniform float uDirDisperse;  // 0 = assembled, 1 = fully scattered
uniform vec3  uDirCenter;    // scatter box centre (world) — the camera's aim point
uniform vec3  uDirAmp;       // box HALF-size along screen (right, up, fwd), world units
uniform float uDirDrift;     // rightward shift of the box centre (world units) — the "blown right" bias
uniform float uDirFade;      // how transparent a fully-scattered splat gets (0 = no fade)
uniform float uDirBoost;     // alpha boost on the assembled model (>1 = denser/richer)
uniform vec3  uDirRight;     // screen-right in world space
uniform vec3  uDirUp;        // screen-up in world space
uniform vec3  uDirFwd;       // view direction in world space

float gtDirT = 0.0; // this splat's eased disperse ramp — read later by the alpha fade

vec3 gtDirHash3(float n){
  vec3 p3 = fract(vec3(n) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}`;

const DIR_DISPLACE = /* glsl */ `
  // --- directional gaussian disperse (injected): morph to a frame-filling, right-shifted box ---
  {
    vec3 rnd = gtDirHash3(float(splatIndex));
    // per-splat stagger + smoothstep — the same easing the baked point-cloud shader applies
    float t = clamp((uDirDisperse - rnd.x * 0.25) / 0.75, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    gtDirT = t;
    if (t > 0.0) {
      vec3 rnd2 = gtDirHash3(float(splatIndex) + 0.618);
      vec3 randTarget = uDirCenter
        + uDirRight * ((rnd2.x * 2.0 - 1.0) * uDirAmp.x + uDirDrift)
        + uDirUp    * ((rnd2.y * 2.0 - 1.0) * uDirAmp.y)
        + uDirFwd   * ((rnd2.z * 2.0 - 1.0) * uDirAmp.z);
      splatCenter = mix(splatCenter, randTarget, t);
    }
  }`;

// After the library derives the splat color: boost the assembled model's opacity (soft
// gaussian edges wash out on a light page — a >1 boost keeps it reading dense and
// photographic), then thin the dust out as it scatters (the baked point cloud did the
// same — 0.9 assembled → 0.55 scattered).
const DIR_COLOR_ANCHOR = "vColor = uintToRGBAVec(sampledCenterColor.r);";
const DIR_COLOR_FADE = /* glsl */ `
  vColor.a = min(1.0, vColor.a * uDirBoost) * (1.0 - uDirFade * gtDirT);`;

export interface DirectionalDisperseHandle {
  /** set 0 (assembled) … 1 (scattered) each frame */
  uniform: { value: number };
  /** scatter box centre — keep on the camera's aim point */
  center: { value: THREE.Vector3 };
  /** world-space screen basis — update from the live camera each frame */
  dirRight: { value: THREE.Vector3 };
  dirUp: { value: THREE.Vector3 };
  dirFwd: { value: THREE.Vector3 };
}

/**
 * Patch a SplatMesh's ShaderMaterial with the DIRECTIONAL (home-hero) disperse. Idempotent.
 * Returns null if the mesh/material isn't ready yet.
 */
export function patchDisperseDirectional(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mesh: any,
  amp: [number, number, number] = [170, 95, 100],
  drift = 60,
  fade = 0.45,
  boost = 1.35,
): DirectionalDisperseHandle | null {
  const mat: THREE.ShaderMaterial | undefined = mesh?.material;
  if (!mat || typeof mat.vertexShader !== "string") return null;

  if (mat.uniforms?.uDirDisperse) {
    return {
      uniform: mat.uniforms.uDirDisperse as { value: number },
      center: mat.uniforms.uDirCenter as { value: THREE.Vector3 },
      dirRight: mat.uniforms.uDirRight as { value: THREE.Vector3 },
      dirUp: mat.uniforms.uDirUp as { value: THREE.Vector3 },
      dirFwd: mat.uniforms.uDirFwd as { value: THREE.Vector3 },
    };
  }
  if (!mat.vertexShader.includes(CENTER_ANCHOR)) return null; // unexpected shader version

  mat.vertexShader = mat.vertexShader
    .replace(DECL_ANCHOR, `${DECL_ANCHOR}${DIR_DECLS}`)
    .replace(CENTER_ANCHOR, `${CENTER_ANCHOR}${DIR_DISPLACE}`)
    .replace(DIR_COLOR_ANCHOR, `${DIR_COLOR_ANCHOR}${DIR_COLOR_FADE}`);
  mat.uniforms.uDirDisperse = { value: 0 };
  mat.uniforms.uDirCenter = { value: new THREE.Vector3() };
  mat.uniforms.uDirAmp = { value: new THREE.Vector3(...amp) };
  mat.uniforms.uDirDrift = { value: drift };
  mat.uniforms.uDirFade = { value: fade };
  mat.uniforms.uDirBoost = { value: boost };
  mat.uniforms.uDirRight = { value: new THREE.Vector3(1, 0, 0) };
  mat.uniforms.uDirUp = { value: new THREE.Vector3(0, 1, 0) };
  mat.uniforms.uDirFwd = { value: new THREE.Vector3(0, 0, -1) };
  mat.needsUpdate = true;

  return {
    uniform: mat.uniforms.uDirDisperse as { value: number },
    center: mat.uniforms.uDirCenter as { value: THREE.Vector3 },
    dirRight: mat.uniforms.uDirRight as { value: THREE.Vector3 },
    dirUp: mat.uniforms.uDirUp as { value: THREE.Vector3 },
    dirFwd: mat.uniforms.uDirFwd as { value: THREE.Vector3 },
  };
}

/**
 * Patch a SplatMesh's ShaderMaterial in place to add the disperse displacement. Idempotent —
 * calling twice returns the existing handle. Returns null if the material isn't the expected
 * shape (e.g. the mesh isn't built yet).
 */
export function patchDisperse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mesh: any,
  amplitude = 25,
  center: [number, number, number] = [-1.5, -1, -4.5],
): DisperseHandle | null {
  const mat: THREE.ShaderMaterial | undefined = mesh?.material;
  if (!mat || typeof mat.vertexShader !== "string") return null;

  // already patched → reuse the live uniforms
  if (mat.uniforms?.uDisperse) {
    return {
      uniform: mat.uniforms.uDisperse as { value: number },
      amp: mat.uniforms.uDisperseAmp as { value: number },
    };
  }
  if (!mat.vertexShader.includes(CENTER_ANCHOR)) return null; // unexpected shader version

  mat.vertexShader = mat.vertexShader
    .replace(DECL_ANCHOR, `${DECL_ANCHOR}${DECLS}`)
    .replace(CENTER_ANCHOR, `${CENTER_ANCHOR}${DISPLACE}`);
  mat.uniforms.uDisperse = { value: 0 };
  mat.uniforms.uDisperseAmp = { value: amplitude };
  mat.uniforms.uDisperseCenter = { value: new THREE.Vector3(...center) };
  mat.needsUpdate = true; // force a recompile with the injected source

  return {
    uniform: mat.uniforms.uDisperse as { value: number },
    amp: mat.uniforms.uDisperseAmp as { value: number },
  };
}
