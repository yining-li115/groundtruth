import * as THREE from "three";

/**
 * Procedural shapes for the scroll-morph experiment, each sampled to EXACTLY the same
 * particle count so the cloud morphs point-for-point. Sampling uses a SEEDED rng so a
 * shape can be rebuilt in a different POSE with identical draw order — that's how the
 * clapping figures get two perfectly-corresponding position sets (pose A / pose B) the
 * shader can swing between while the shape is held.
 *
 * Sequence: city → mapping car → satellite → two clapping figures (animated) → dust.
 */

export const N = 70000;
export const SHAPE_COUNT = 5;

/* ---- seeded rng (mulberry32) — deterministic sampling, pose-to-pose correspondence ---- */
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

/* ---- box-surface sampling in local space, placed by a matrix ---- */
interface Part {
  w: number;
  h: number;
  d: number;
  m: THREE.Matrix4;
}
const part = (w: number, h: number, d: number, m: THREE.Matrix4): Part => ({ w, h, d, m });
const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const area = (p: Part) => 2 * (p.w * p.h + p.w * p.d + p.h * p.d);

function samplePartsSeeded(
  parts: Part[],
  n: number,
  rng: Rng,
  scale: number,
  yShift: number,
): Float32Array {
  const out = new Float32Array(n * 3);
  const total = parts.reduce((s, p) => s + area(p), 0) || 1;
  const v = new THREE.Vector3();
  let i = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi]!;
    const want = pi === parts.length - 1 ? n - i : Math.round((n * area(p)) / total);
    const { w, h, d } = p;
    // face areas: ±z (w·h), ±y (w·d), ±x (h·d)
    const af = w * h, at = w * d, as = h * d;
    const sum = 2 * (af + at + as);
    for (let k = 0; k < want && i < n; k++, i++) {
      const r = rng() * sum;
      const u = rng() - 0.5, q = rng() - 0.5, sgn = rng() < 0.5 ? -1 : 1;
      if (r < 2 * af) v.set(u * w, q * h, sgn * (d / 2));
      else if (r < 2 * (af + at)) v.set(u * w, sgn * (h / 2), q * d);
      else v.set(sgn * (w / 2), u * h, q * d);
      const jit = 0.012 + rng() * 0.028;
      v.x += (rng() - 0.5) * jit * 2;
      v.y += (rng() - 0.5) * jit * 2;
      v.z += (rng() - 0.5) * jit * 2;
      v.applyMatrix4(p.m);
      out[i * 3] = v.x * scale;
      out[i * 3 + 1] = v.y * scale + yShift;
      out[i * 3 + 2] = v.z * scale;
    }
  }
  return out;
}

/* ---------------------------------- shapes ---------------------------------- */

function cityShape(): Float32Array {
  const rng = mulberry32(11);
  const parts: Part[] = [];
  const span = 5, cells = 6, cell = span / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      if (rng() < 0.2) continue;
      const cx = -span / 2 + (i + 0.5) * cell;
      const cz = -span / 2 + (j + 0.5) * cell;
      const maxH = THREE.MathUtils.lerp(3.4, 0.8, Math.min(Math.hypot(cx, cz) / 3, 1));
      const h = THREE.MathUtils.lerp(0.6, maxH, rng());
      parts.push(
        part(
          cell * (0.45 + rng() * 0.37),
          h,
          cell * (0.45 + rng() * 0.37),
          T(cx + (rng() - 0.5) * cell * 0.4, h / 2, cz + (rng() - 0.5) * cell * 0.4),
        ),
      );
    }
  }
  return samplePartsSeeded(parts, N, rng, 1.0, -1.4);
}

function carShape(): Float32Array {
  const rng = mulberry32(22);
  const wheel = (dx: number, dz: number) => part(0.18, 0.18, 0.14, T(dx, 0.09, dz));
  const parts: Part[] = [
    part(1.05, 0.24, 0.5, T(0, 0.18, 0)), // body
    part(0.55, 0.24, 0.46, T(-0.02, 0.42, 0)), // cabin
    part(0.06, 0.16, 0.06, T(0.2, 0.62, 0)), // roof sensor mast (it's a mapping car)
    part(0.3, 0.06, 0.3, T(0.2, 0.72, 0)), // roof lidar puck
    wheel(-0.36, 0.22),
    wheel(0.36, 0.22),
    wheel(-0.36, -0.22),
    wheel(0.36, -0.22),
  ];
  return samplePartsSeeded(parts, N, rng, 3.6, -1.2);
}

function satelliteShape(): Float32Array {
  const rng = mulberry32(33);
  const parts: Part[] = [
    part(0.55, 0.55, 0.55, T(0, 0, 0)), // bus
    part(1.1, 0.04, 0.5, T(-0.92, 0, 0)), // panel L
    part(1.1, 0.04, 0.5, T(0.92, 0, 0)), // panel R
    part(0.06, 0.5, 0.06, T(0, 0.5, 0)), // antenna boom
    part(0.34, 0.08, 0.34, T(0, 0.78, 0)), // dish
  ];
  return samplePartsSeeded(parts, N, rng, 2.1, 0);
}

/**
 * Two figures facing each other, arms reaching toward the middle. `clap` ∈ [0,1] swings
 * the arms at the shoulder: 0 = arms apart (wound up), 1 = hands met in the middle.
 * Called twice with the same seed → identical sampling → per-particle correspondence.
 */
function peopleShape(clap: number): Float32Array {
  const rng = mulberry32(44);
  const parts: Part[] = [];
  const armAngle = THREE.MathUtils.lerp(-1.0, -0.06, clap); // shoulder pitch (radians)

  const addFigure = (sideX: number, facing: number) => {
    // facing: +1 = looking toward +x (the middle), applied as a Y-rotation for the right figure
    const fig = new THREE.Matrix4()
      .makeRotationY(facing > 0 ? 0 : Math.PI)
      .setPosition(sideX, 0, 0);
    const at = (m: THREE.Matrix4) => m.premultiply(fig);
    // legs / torso / head
    parts.push(part(0.2, 1.05, 0.26, at(T(0, 0.55, 0.15))));
    parts.push(part(0.2, 1.05, 0.26, at(T(0, 0.55, -0.15))));
    parts.push(part(0.56, 0.85, 0.32, at(T(0, 1.5, 0))));
    parts.push(part(0.32, 0.34, 0.32, at(T(0, 2.12, 0))));
    // arms: boxes running along +x from a shoulder pivot, pitched by `armAngle`
    const arm = (shoulderZ: number) => {
      const L = 0.78;
      const m = new THREE.Matrix4()
        .makeTranslation(L / 2 + 0.06, 0, 0) // pivot at the shoulder end
        .premultiply(new THREE.Matrix4().makeRotationZ(armAngle))
        .premultiply(T(0.2, 1.78, shoulderZ)); // shoulder joint on the torso front-top
      at(m);
      parts.push(part(L, 0.15, 0.15, m));
      // hand
      const hand = new THREE.Matrix4()
        .makeTranslation(L + 0.12, 0, 0)
        .premultiply(new THREE.Matrix4().makeRotationZ(armAngle))
        .premultiply(T(0.2, 1.78, shoulderZ));
      at(hand);
      parts.push(part(0.16, 0.2, 0.16, hand));
    };
    arm(0.16);
    arm(-0.16);
  };

  addFigure(-1.18, +1);
  addFigure(1.18, -1);
  return samplePartsSeeded(parts, N, rng, 1.5, -1.7);
}

/** Loose drifting cloud — the "raw data" finale. Volume, not surface. */
function dustShape(): Float32Array {
  const rng = mulberry32(55);
  const out = new Float32Array(N * 3);
  const g = () => rng() + rng() - 1;
  for (let i = 0; i < N; i++) {
    out[i * 3] = g() * 3.4;
    out[i * 3 + 1] = g() * 1.5;
    out[i * 3 + 2] = g() * 1.8;
  }
  return out;
}

/** [city, car, satellite, peopleA(open), peopleB(clapped), dust] */
export function buildShapes(): Float32Array[] {
  return [cityShape(), carShape(), satelliteShape(), peopleShape(0), peopleShape(1), dustShape()];
}
