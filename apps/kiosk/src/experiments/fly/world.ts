import * as THREE from "three";
import { ELEMENT_RAMPS, type Ramp } from "./assetColors";

/**
 * The persistent particle WORLD for the fly-through experiment: city blocks + mapping
 * car + two satellites + survey drone + sensor data lines, all sampled into ONE static
 * buffer (the camera moves, the world stays). Same procedural vocabulary as the home
 * hero (experiments/showcase/Scene) plus a drone, coloured per element.
 *
 * Element anchor positions are exported for the camera stops.
 */

export const N = 120000;

export const ANCHORS = {
  worldCenter: new THREE.Vector3(0, 1, 0),
  sat1: new THREE.Vector3(-1.6, 4.4, -1),
  sat2: new THREE.Vector3(2.0, 3.7, -2),
  car: new THREE.Vector3(-3.2, 0.35, 3.4),
  drone: new THREE.Vector3(2.6, 2.2, 2.0),
};

/* ---- seeded rng — a stable world across reloads ---- */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;

interface Part {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
}
const area = (p: Part) => 2 * (p.w * p.h + p.w * p.d + p.h * p.d);

export interface World {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  rands: Float32Array;
  alphas: Float32Array;
}

interface Buffers extends World {
  i: number;
}

function pushPoint(
  b: Buffers,
  rng: Rng,
  x: number,
  y: number,
  z: number,
  ramp: Ramp,
  hNorm: number,
  baseAlpha: number,
  sizeScale = 1,
) {
  if (b.i >= N) return;
  const i = b.i++;
  b.positions[i * 3] = x;
  b.positions[i * 3 + 1] = y;
  b.positions[i * 3 + 2] = z;
  // colour ramp by height + jitter; a few "bokeh" particles go big and faint
  const m = Math.min(Math.max(hNorm + (rng() - 0.5) * 0.35, 0), 1);
  const c = ramp.a.clone().lerp(ramp.b, m);
  b.colors[i * 3] = c.r;
  b.colors[i * 3 + 1] = c.g;
  b.colors[i * 3 + 2] = c.b;
  const bokeh = rng() < 0.04;
  b.sizes[i] = (bokeh ? 3.5 + rng() * 3 : 0.4 + rng() * rng() * 1.6) * sizeScale;
  b.alphas[i] = bokeh ? 0.09 : baseAlpha;
  b.rands[i] = rng();
}

/** Surface-sample a set of boxes; hNorm runs over the element's own height range. */
function sampleParts(
  b: Buffers,
  rng: Rng,
  parts: Part[],
  count: number,
  ramp: Ramp,
  baseAlpha = 0.75,
) {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of parts) {
    yMin = Math.min(yMin, p.y - p.h / 2);
    yMax = Math.max(yMax, p.y + p.h / 2);
  }
  const span = yMax - yMin || 1;
  const total = parts.reduce((s, p) => s + area(p), 0) || 1;
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi]!;
    const want =
      pi === parts.length - 1
        ? count - Math.round((count * (total - area(p))) / total)
        : Math.round((count * area(p)) / total);
    const { w, h, d } = p;
    const af = w * h, at = w * d, as = h * d;
    const sum = 2 * (af + at + as);
    for (let k = 0; k < want; k++) {
      const r = rng() * sum;
      const u = rng() - 0.5, q = rng() - 0.5, sgn = rng() < 0.5 ? -1 : 1;
      let lx = 0, ly = 0, lz = 0;
      if (r < 2 * af) { lx = u * w; ly = q * h; lz = sgn * (d / 2); }
      else if (r < 2 * (af + at)) { lx = u * w; ly = sgn * (h / 2); lz = q * d; }
      else { lx = sgn * (w / 2); ly = u * h; lz = q * d; }
      const jit = 0.012 + rng() * 0.028;
      const x = p.x + lx + (rng() - 0.5) * jit * 2;
      const y = p.y + ly + (rng() - 0.5) * jit * 2;
      const z = p.z + lz + (rng() - 0.5) * jit * 2;
      pushPoint(b, rng, x, y, z, ramp, (y - yMin) / span, baseAlpha);
    }
  }
}

/** Scattered points along a sensor → subject acquisition line. */
function sampleLine(
  b: Buffers,
  rng: Rng,
  from: THREE.Vector3,
  to: THREE.Vector3,
  count: number,
) {
  for (let k = 0; k < count; k++) {
    const t = rng();
    pushPoint(
      b,
      rng,
      from.x + (to.x - from.x) * t + (rng() - 0.5) * 0.12,
      from.y + (to.y - from.y) * t + (rng() - 0.5) * 0.12,
      from.z + (to.z - from.z) * t + (rng() - 0.5) * 0.12,
      ELEMENT_RAMPS.lines,
      t,
      0.45,
      0.6,
    );
  }
}

export function buildWorld(): World {
  const rng = mulberry32(7);
  const b: Buffers = {
    positions: new Float32Array(N * 3),
    colors: new Float32Array(N * 3),
    sizes: new Float32Array(N),
    rands: new Float32Array(N),
    alphas: new Float32Array(N),
    i: 0,
  };

  // ---- city (55%) ----
  const city: Part[] = [];
  const span = 5, cells = 6, cell = span / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      if (rng() < 0.22) continue;
      const cx = -span / 2 + (i + 0.5) * cell;
      const cz = -span / 2 + (j + 0.5) * cell;
      const maxH = THREE.MathUtils.lerp(3.4, 0.8, Math.min(Math.hypot(cx, cz) / 3, 1));
      const h = THREE.MathUtils.lerp(0.6, maxH, rng());
      city.push({
        w: cell * (0.45 + rng() * 0.37),
        h,
        d: cell * (0.45 + rng() * 0.37),
        x: cx + (rng() - 0.5) * cell * 0.4,
        y: h / 2,
        z: cz + (rng() - 0.5) * cell * 0.4,
      });
    }
  }
  sampleParts(b, rng, city, Math.round(N * 0.55), ELEMENT_RAMPS.city);

  // ---- satellites (2 × 6%) ----
  const sat = (bx: number, by: number, bz: number): Part[] => [
    { w: 0.5, h: 0.5, d: 0.5, x: bx, y: by, z: bz },
    { w: 0.95, h: 0.03, d: 0.45, x: bx - 0.78, y: by, z: bz },
    { w: 0.95, h: 0.03, d: 0.45, x: bx + 0.78, y: by, z: bz },
    { w: 0.05, h: 0.45, d: 0.05, x: bx, y: by + 0.42, z: bz },
  ];
  sampleParts(b, rng, sat(ANCHORS.sat1.x, ANCHORS.sat1.y, ANCHORS.sat1.z), Math.round(N * 0.06), ELEMENT_RAMPS.satellite);
  sampleParts(b, rng, sat(ANCHORS.sat2.x, ANCHORS.sat2.y, ANCHORS.sat2.z), Math.round(N * 0.06), ELEMENT_RAMPS.satellite);

  // ---- mapping car (10%) ----
  const cx = ANCHORS.car.x, cz = ANCHORS.car.z;
  const wheel = (dx: number, dz: number): Part => ({ w: 0.16, h: 0.16, d: 0.12, x: cx + dx, y: 0.08, z: cz + dz });
  const car: Part[] = [
    { w: 0.95, h: 0.22, d: 0.46, x: cx, y: 0.27, z: cz },
    { w: 0.5, h: 0.22, d: 0.42, x: cx, y: 0.51, z: cz },
    { w: 0.05, h: 0.14, d: 0.05, x: cx + 0.1, y: 0.69, z: cz },
    { w: 0.26, h: 0.05, d: 0.26, x: cx + 0.1, y: 0.78, z: cz }, // roof lidar puck
    wheel(-0.34, 0.19), wheel(0.34, 0.19), wheel(-0.34, -0.19), wheel(0.34, -0.19),
  ];
  sampleParts(b, rng, car, Math.round(N * 0.1), ELEMENT_RAMPS.car);

  // ---- survey drone (8%) ----
  const dx0 = ANCHORS.drone.x, dy0 = ANCHORS.drone.y, dz0 = ANCHORS.drone.z;
  const drone: Part[] = [{ w: 0.34, h: 0.14, d: 0.34, x: dx0, y: dy0, z: dz0 }];
  for (const [ax, az] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
    drone.push({ w: 0.34, h: 0.04, d: 0.06, x: dx0 + ax * 0.24, y: dy0 + 0.04, z: dz0 + az * 0.24 });
    drone.push({ w: 0.3, h: 0.02, d: 0.3, x: dx0 + ax * 0.4, y: dy0 + 0.1, z: dz0 + az * 0.4 }); // rotor disc
  }
  drone.push({ w: 0.1, h: 0.1, d: 0.1, x: dx0, y: dy0 - 0.12, z: dz0 }); // camera gimbal
  sampleParts(b, rng, drone, Math.round(N * 0.08), ELEMENT_RAMPS.drone);

  // ---- data lines (rest ≈ 15%) ----
  const left = N - b.i;
  const per = Math.floor(left / 4);
  sampleLine(b, rng, ANCHORS.sat1, new THREE.Vector3(-0.5, 2.4, 0), per);
  sampleLine(b, rng, ANCHORS.sat2, new THREE.Vector3(0.8, 2.2, 0), per);
  sampleLine(b, rng, new THREE.Vector3(cx, 0.5, cz), new THREE.Vector3(-0.6, 0.8, 0.4), per);
  sampleLine(b, rng, ANCHORS.drone, new THREE.Vector3(1.8, 0.6, 1.2), N - b.i);

  return b;
}
