import * as THREE from "three";
import { loadBakedCloud, type BakedCloud } from "../experiments/showcase/loadBakedCloud";

/**
 * Shared point-cloud core — the morph shader + geometry builder used by BOTH the CV
 * experiment (/?exp=cv) and the idle showreel. A point sits at its Gaussian's centre and
 * carries the source colour + opacity + footprint; `uProgress` morphs each point between a
 * radial "scattered" position and its "assembled" target so a hand gesture (or the showreel
 * timeline) can disperse/reassemble the building.
 */

export type { BakedCloud };
export { loadBakedCloud };

/** Normalise any baked cloud to roughly this half-extent (world units) after centring. */
export const TARGET_HALF = 3.5;

// Morph shader with a tunable base opacity so a dense cloud reads as a solid building.
export const POINT_VERT = /* glsl */ `
  uniform float uProgress; uniform float uSize; uniform float uAlpha;
  attribute vec3 aTarget; attribute float aRand; attribute float aSize; attribute vec3 aColor;
  attribute float aOpacity;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    float t = clamp((uProgress - aRand * 0.25) / 0.75, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 p = mix(position, aTarget, t);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aSize * (320.0 / -mv.z);
    vAlpha = (0.55 + 0.35 * t) * uAlpha * aOpacity;
    vColor = aColor;
  }
`;
export const POINT_FRAG = /* glsl */ `
  uniform sampler2D uMap; varying float vAlpha; varying vec3 vColor;
  void main() {
    float m = texture2D(uMap, gl_PointCoord).a;
    gl_FragColor = vec4(vColor, m * vAlpha);
  }
`;

/** Soft round sprite so points read as feathered dust, not hard squares. */
export function makeSprite(): THREE.Texture {
  const s = 64;
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = s;
  const ctx = cnv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cnv);
  tex.needsUpdate = true;
  return tex;
}

/** Build morph geometry from a baked cloud: centre + scale, radial scatter, real colours. */
export function buildCloudGeometry(cloud: BakedCloud): THREE.BufferGeometry {
  const { count, positions, rgba, sizes } = cloud;

  const bMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const bMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    bMin.min(p);
    bMax.max(p);
  }
  const c = bMin.clone().add(bMax).multiplyScalar(0.5);
  const extent = Math.max(bMax.x - bMin.x, bMax.y - bMin.y, bMax.z - bMin.z) || 1;
  const scale = (TARGET_HALF * 2) / extent;

  const target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  const sizeAttr = new Float32Array(count);
  const rand = new Float32Array(count);
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    v.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
      .sub(c)
      .multiplyScalar(scale);
    target[i * 3] = v.x;
    target[i * 3 + 1] = v.y;
    target[i * 3 + 2] = v.z;

    // radial burst outward from centre (dispersed state)
    let dx = v.x, dy = v.y, dz = v.z;
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) {
      dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5;
      len = Math.hypot(dx, dy, dz) || 1;
    }
    const blow = 3 + Math.random() * 8;
    scatter[i * 3] = v.x + (dx / len) * blow + THREE.MathUtils.randFloatSpread(1.5);
    scatter[i * 3 + 1] = v.y + (dy / len) * blow + THREE.MathUtils.randFloatSpread(1.5);
    scatter[i * 3 + 2] = v.z + (dz / len) * blow + THREE.MathUtils.randFloatSpread(1.5);

    col[i * 3] = rgba[i * 4]! / 255;
    col[i * 3 + 1] = rgba[i * 4 + 1]! / 255;
    col[i * 3 + 2] = rgba[i * 4 + 2]! / 255;
    opacity[i] = rgba[i * 4 + 3]! / 255;
    sizeAttr[i] = sizes[i]!;
    rand[i] = Math.random();
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(scatter, 3));
  g.setAttribute("aTarget", new THREE.BufferAttribute(target, 3));
  g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aOpacity", new THREE.BufferAttribute(opacity, 1));
  g.setAttribute("aSize", new THREE.BufferAttribute(sizeAttr, 1));
  g.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
  return g;
}
