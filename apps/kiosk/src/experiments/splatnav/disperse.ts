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
