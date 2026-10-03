import * as THREE from "three";
import { computeFlow, sampleFlow, toGray } from "./opticalFlow";

/**
 * Turn a picture into a fixed-size cloud of 2D particles.
 *
 * Every frame in the story has to yield EXACTLY the same particle count, because the morph
 * between two frames is a per-particle interpolation — particle 5,000 travels from where it
 * sits in frame A to where it sits in frame B. Frames naturally produce different numbers of
 * bright pixels, so each one is resampled to the same N: too few candidates and particles are
 * reused (several land on the same pixel, which reads as density rather than error), too many
 * and a random subset is taken.
 *
 * Sampling is weighted toward brightness rather than thresholded. A hard cutoff throws away
 * the dim half of a subject and leaves a hollow shell; weighting keeps faint structure as
 * sparse points, which is what makes the field read as a photograph rather than a stencil.
 */

export interface ParticleFrame {
  /** xyz per particle, laid out in a plane: x,y in [-aspect/2, aspect/2] × [-0.5, 0.5], z = 0 */
  positions: Float32Array;
  /** rgb per particle, straight from the pixel */
  colors: Float32Array;
}

/** Luminance, the usual perceptual weights. */
const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Load one act as a SHARED particle field: positions are sampled once, and each frame only
 * recolours them.
 *
 * Sampling every frame independently — even with the clouds sorted onto the same space-filling
 * curve — gives particle 5,000 no relationship to particle 5,000 in the next frame. It is the
 * same robot arm in both, but nothing in the data says so, so the field scrambles on every
 * change and the motion never reads as one thing moving.
 *
 * Fixing the positions makes the field a screen and the frames a picture playing on it: the
 * subject moves because the ink moves across the dots, not because the dots fly around. Within
 * an act that is exactly right. Between acts the picture really does become something else, and
 * there the particles are allowed to travel.
 */
/**
 * Ink curve. Below 1 the midtones go dark and the whole frame fills with grey mush; above 1
 * only the highlights take ink and the subject sits in white space, which is what makes a
 * stipple readable. Live-tunable: ?inkgamma=
 */
const INK_GAMMA = (() => {
  const v = Number(
    typeof window === "undefined" ? NaN : new URLSearchParams(location.search).get("inkgamma"),
  );
  return Number.isFinite(v) && v > 0 ? v : 1.9;
})();

export interface FieldOptions {
  /** duotone stipple for a pale ground: bright pixel -> dark dot */
  ink?: boolean;
  minLuma?: number;
  sampleWidth?: number;
}

export async function loadActField(
  urls: string[],
  count: number,
  opts: FieldOptions = {},
): Promise<ParticleFrame[]> {
  if (!urls.length) return [];

  // ONE set of particles, sampled from the first frame. Every later frame is that same set
  // carried along by how the picture moved — never a fresh sampling, which would break the
  // correspondence, and never a fixed grid that merely changes colour, which inks every pose
  // at once and reads as three arms superimposed.
  const first = await loadImageParticles(urls[0]!, count, {
    minLuma: opts.minLuma ?? 0.14,
    sampleWidth: opts.sampleWidth,
    autoExposure: false,
    align: false,
  });

  const grids = await Promise.all(urls.map((u) => sampleGrid(u, opts)));
  const grays = grids.map((g) => toGray(g.data, g.w, g.h));

  const out: ParticleFrame[] = [];
  const pos = first.positions.slice();
  const aspect = grids[0]!.w / grids[0]!.h;

  for (let f = 0; f < urls.length; f += 1) {
    if (f > 0) {
      // advect: move each particle by the displacement between this frame and the last
      const flow = computeFlow(grays[f - 1]!, grays[f]!);
      for (let i = 0; i < count; i += 1) {
        const u = pos[i * 3]! / aspect + 0.5;
        const v = -pos[i * 3 + 1]! + 0.5;
        const [sx, sy] = sampleFlow(flow, u, v);
        pos[i * 3] = (u + sx - 0.5) * aspect;
        pos[i * 3 + 1] = -(v + sy - 0.5);
      }
    }
    out.push({
      positions: pos.slice(),
      // colour is read where the particle now sits, so ink follows the surface it landed on
      colors: colorsAt(pos, count, grids[f]!, opts),
    });
  }
  return out;
}

/** Decode an image once into a flat RGB grid we can look positions up in. */
async function sampleGrid(url: string, opts: { sampleWidth?: number } = {}) {
  const { sampleWidth = 640 } = opts;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const w = Math.min(sampleWidth, img.naturalWidth);
  const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

/** Look up each particle's colour in one frame's grid. */
function colorsAt(
  positions: Float32Array,
  count: number,
  grid: { w: number; h: number; data: Uint8ClampedArray },
  opts: FieldOptions = {},
): Float32Array {
  const { w, h, data } = grid;
  const aspect = w / h;
  const out = new Float32Array(count * 3);
  const lum = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const px = Math.round((positions[i * 3]! / aspect + 0.5) * w);
    const py = Math.round((-positions[i * 3 + 1]! + 0.5) * h);
    const o = (Math.min(Math.max(py, 0), h - 1) * w + Math.min(Math.max(px, 0), w - 1)) * 4;
    const r = data[o]! / 255;
    const g = data[o + 1]! / 255;
    const b = data[o + 2]! / 255;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }

  // Stretch this frame's own tonal range to fill 0..1 BEFORE anything else. A night photograph
  // spans maybe 0.05..0.45, so inverting it first — as the previous version did — produced
  // light grey ink on a pale ground and the subject all but vanished. Per frame, so exposure
  // drift between chain-generated frames doesn't show as the picture pulsing.
  const sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(count * 0.02)] ?? 0;
  const hi = sorted[Math.floor(count * 0.98)] ?? 1;
  const span = Math.max(hi - lo, 1e-3);

  for (let i = 0; i < count; i += 1) {
    const v = Math.min(Math.max((lum[i]! - lo) / span, 0), 1);
    if (opts.ink) {
      // Duotone stipple: the brightest part of the picture becomes the DARKEST ink. The gamma
      // pushes midtones down so the subject reads as ink rather than as haze.
      const d = 1 - Math.pow(v, INK_GAMMA);
      out[i * 3] = d;
      out[i * 3 + 1] = d;
      out[i * 3 + 2] = d;
    } else {
      const k = v / (lum[i]! || 1e-3);
      out[i * 3] = Math.min(1, out[i * 3]! * k);
      out[i * 3 + 1] = Math.min(1, out[i * 3 + 1]! * k);
      out[i * 3 + 2] = Math.min(1, out[i * 3 + 2]! * k);
    }
  }

  return out;
}

export async function loadImageParticles(
  url: string,
  count: number,
  opts: {
    minLuma?: number;
    gamma?: number;
    sampleWidth?: number;
    invert?: boolean;
    align?: boolean;
    autoExposure?: boolean;
  } = {},
): Promise<ParticleFrame> {
  const {
    minLuma = 0.16,
    gamma = 0.75,
    sampleWidth = 640,
    invert = false,
    align = true,
    autoExposure = true,
  } = opts;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();

  // Work at a reduced width: the source is far denser than the particle count needs, and
  // reading a full-size ImageData buffer per frame is the slow part of loading.
  const w = Math.min(sampleWidth, img.naturalWidth);
  const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Build a weighted list of candidate pixels. Weight is luminance raised to `gamma`, so
  // bright structure attracts more particles than dim structure without silencing it.
  const idx: number[] = [];
  const cum: number[] = [];
  let total = 0;
  for (let p = 0; p < w * h; p += 1) {
    const o = p * 4;
    const a = data[o + 3]! / 255;
    if (a < 0.5) continue;
    const l = lum(data[o]!, data[o + 1]!, data[o + 2]!);
    if (l < minLuma) continue;
    total += Math.pow(l, gamma);
    idx.push(p);
    cum.push(total);
  }

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const aspect = w / h;

  if (!idx.length) return { positions, colors }; // an all-black frame — leave it empty

  // Deterministic sampling: the same image always yields the same particle layout, so a frame
  // that appears twice in the story morphs back to exactly where it was.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1e6) / 1e6;
  };

  for (let i = 0; i < count; i += 1) {
    // inverse-CDF pick, so weight actually drives the distribution
    const target = rand() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const p = idx[lo]!;
    const px = p % w;
    const py = (p / w) | 0;
    const o = p * 4;

    // jitter inside the pixel so a sampled cell doesn't show as a hard grid
    positions[i * 3] = ((px + rand()) / w - 0.5) * aspect;
    positions[i * 3 + 1] = -((py + rand()) / h - 0.5);
    positions[i * 3 + 2] = 0;

    // Inverted for the light theme: the frames are bright subjects on black, and on a
    // near-white ground the dust has to be dark to read at all.
    const r = data[o]! / 255;
    const g = data[o + 1]! / 255;
    const b = data[o + 2]! / 255;
    colors[i * 3] = invert ? 1 - r : r;
    colors[i * 3 + 1] = invert ? 1 - g : g;
    colors[i * 3 + 2] = invert ? 1 - b : b;
  }

  // ---- exposure -----------------------------------------------------------------------
  // Night photography sampled straight gives near-black particles on a near-black ground:
  // technically correct, visually nothing. What carries a particle field is CONTRAST, so
  // stretch each frame's own tonal range to fill the display range. Doing it per frame also
  // levels out the exposure drift that chain generation introduces, which would otherwise
  // show up as the whole picture pulsing brighter and darker as the loop cycles.
  if (autoExposure) stretchExposure(colors, count);

  // ---- alignment ----------------------------------------------------------------------
  // Chain generation keeps the subject recognisable but does NOT keep it still: it drifts and
  // rescales from frame to frame. Any such drift becomes a global translation during the
  // morph, and a whole picture sliding sideways is exactly what reads as a slideshow, however
  // good the per-particle correspondence is. Normalise every frame to a common centroid and
  // spread, so what remains between frames is the change we actually want to see.
  if (align) alignCloud(positions, count);

  // ---- correspondence ----------------------------------------------------------------
  // Sort both frames by the same space-filling curve so particle i sits in the same REGION in
  // every frame. Without this each particle is assigned a random target and crosses the whole
  // picture on every change, which the eye reads as two clouds cross-fading — a slideshow with
  // extra steps. Sorted, each particle only has to travel to something near where it already
  // is, and the field reads as flowing into a new shape.
  sortByMorton(positions, colors, count);

  return { positions, colors };
}

/** Stretch the sampled colours so the frame's own brightest points reach full display range. */
function stretchExposure(colors: Float32Array, count: number): void {
  const l = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    l[i] = 0.2126 * colors[i * 3]! + 0.7152 * colors[i * 3 + 1]! + 0.0722 * colors[i * 3 + 2]!;
  }
  const sorted = Float32Array.from(l).sort();
  // percentiles, not min/max: a handful of specular pixels shouldn't set the whole scale
  const lo = sorted[Math.floor(count * 0.02)] ?? 0;
  const hi = sorted[Math.floor(count * 0.98)] ?? 1;
  const span = Math.max(hi - lo, 1e-3);
  for (let i = 0; i < count; i += 1) {
    const k = (Math.min(Math.max((l[i]! - lo) / span, 0), 1) + 0.12) / (l[i]! || 1e-3);
    for (let c = 0; c < 3; c += 1) {
      colors[i * 3 + c] = Math.min(1, colors[i * 3 + c]! * k);
    }
  }
}

/** Centre the cloud and normalise its spread, so frames sit on top of one another. */
function alignCloud(positions: Float32Array, count: number): void {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i += 1) {
    cx += positions[i * 3]!;
    cy += positions[i * 3 + 1]!;
  }
  cx /= count;
  cy /= count;
  let varsum = 0;
  for (let i = 0; i < count; i += 1) {
    const dx = positions[i * 3]! - cx;
    const dy = positions[i * 3 + 1]! - cy;
    varsum += dx * dx + dy * dy;
  }
  // RMS radius as the scale measure — robust to a few strays in a way a bounding box is not
  const rms = Math.sqrt(varsum / count) || 1;
  const k = 0.42 / rms; // target radius, chosen so a typical frame fills the view
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (positions[i * 3]! - cx) * k;
    positions[i * 3 + 1] = (positions[i * 3 + 1]! - cy) * k;
  }
}

/** Interleave the bits of two 16-bit coordinates — Z-order, so nearby points sort together. */
function morton(x: number, y: number): number {
  const part = (n: number) => {
    n &= 0xffff;
    n = (n | (n << 8)) & 0x00ff00ff;
    n = (n | (n << 4)) & 0x0f0f0f0f;
    n = (n | (n << 2)) & 0x33333333;
    n = (n | (n << 1)) & 0x55555555;
    return n;
  };
  return part(x) | (part(y) << 1);
}

function sortByMorton(positions: Float32Array, colors: Float32Array, count: number): void {
  const order = new Uint32Array(count);
  const keys = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    order[i] = i;
    // positions are roughly [-1, 1]; quantise to a 1024 grid for the curve
    const gx = Math.max(0, Math.min(1023, Math.round((positions[i * 3]! + 1) * 256)));
    const gy = Math.max(0, Math.min(1023, Math.round((positions[i * 3 + 1]! + 1) * 256)));
    keys[i] = morton(gx, gy);
  }
  const idx = Array.from(order).sort((a, b) => keys[a]! - keys[b]!);
  const p = positions.slice();
  const c = colors.slice();
  for (let i = 0; i < count; i += 1) {
    const j = idx[i]!;
    positions[i * 3] = p[j * 3]!;
    positions[i * 3 + 1] = p[j * 3 + 1]!;
    positions[i * 3 + 2] = p[j * 3 + 2]!;
    colors[i * 3] = c[j * 3]!;
    colors[i * 3 + 1] = c[j * 3 + 1]!;
    colors[i * 3 + 2] = c[j * 3 + 2]!;
  }
}

/** Per-particle random values reused by the morph shader — swirl direction and timing offset. */
export function morphNoise(count: number): { seedA: Float32Array; seedB: Float32Array } {
  const seedA = new Float32Array(count * 3);
  const seedB = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    // a direction on the unit disc, scaled by a random radius — the arc a particle bulges
    // along mid-flight, so the swarm billows instead of sliding in straight lines
    const a = Math.random() * Math.PI * 2;
    const r = 0.05 + Math.random() * 0.35;
    seedA[i * 3] = Math.cos(a) * r;
    seedA[i * 3 + 1] = Math.sin(a) * r;
    seedA[i * 3 + 2] = (Math.random() - 0.5) * 0.6; // out-of-plane bulge, for depth
    seedB[i] = Math.random(); // staggers when each particle sets off
  }
  return { seedA, seedB };
}

export const morphVertexShader = /* glsl */ `
  attribute vec3 posA;
  attribute vec3 posB;
  attribute vec3 colA;
  attribute vec3 colB;
  attribute vec3 swirl;
  attribute float stagger;

  uniform float uT;         // 0 = frame A, 1 = frame B
  uniform float uSize;      // point diameter in CSS pixels at the plane's distance
  uniform float uScale;     // world units per image height
  uniform float uSpread;    // how far particles bulge off the direct path
  uniform float uDpr;       // device pixel ratio — gl_PointSize is in device pixels
  uniform float uRefZ;      // camera distance the size is calibrated at
  uniform float uTime;      // for the idle churn
  uniform float uChurn;     // amplitude of that churn
  uniform float uDim;       // how much to dim particles in transit

  varying vec3 vColor;
  varying float vFade;

  void main() {
    // Stagger the departures: everything moving on the same clock reads as a slide, a spread
    // of start times reads as a swarm changing its mind.
    float t = clamp((uT - stagger * 0.25) / 0.75, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);

    vec3 p = mix(posA, posB, t);
    // bulge outward at mid-flight and return — zero at both ends, so frames land exactly
    p += swirl * sin(t * 3.14159265) * uSpread;
    // Restless even at rest. A field that freezes between changes reads as a still image that
    // someone occasionally swaps; a field that keeps simmering reads as a material.
    p += vec2(
      sin(uTime * 0.7 + stagger * 43.0),
      cos(uTime * 0.6 + stagger * 71.0)
    ).xyy * vec3(1.0, 1.0, 0.0) * uChurn;

    vColor = mix(colA, colB, t);
    // dim in transit: a particle between two homes is not depicting anything yet
    vFade = 1.0 - uDim * sin(t * 3.14159265);

    vec4 mv = modelViewMatrix * vec4(p * uScale, 1.0);
    gl_Position = projectionMatrix * mv;
    // uSize is a pixel diameter, not an arbitrary factor. The previous form multiplied by a
    // made-up 300, which at this camera distance produced ~80px blobs — forty times too big.
    gl_PointSize = uSize * uDpr * (uRefZ / -mv.z);
  }
`;

export const morphFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vFade;

  void main() {
    // round, soft-edged point — square points read as pixels rather than particles
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float alpha = smoothstep(0.25, 0.02, r);
    gl_FragColor = vec4(vColor, alpha * vFade);
  }
`;

/** Fill the geometry attributes for one A→B pair, allocating on first use. */
export function setMorphPair(
  geo: THREE.BufferGeometry,
  a: ParticleFrame,
  b: ParticleFrame,
): void {
  const put = (name: string, src: Float32Array, itemSize: number) => {
    const existing = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (existing && existing.array.length === src.length) {
      (existing.array as Float32Array).set(src);
      existing.needsUpdate = true;
    } else {
      geo.setAttribute(name, new THREE.BufferAttribute(src.slice(), itemSize));
    }
  };
  put("posA", a.positions, 3);
  put("posB", b.positions, 3);
  put("colA", a.colors, 3);
  put("colB", b.colors, 3);
}
