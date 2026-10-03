/**
 * Estimate where each part of one frame moved to in the next, so a single set of particles can
 * be carried through an animation instead of being re-sampled per frame.
 *
 * Re-sampling each frame independently gives particle 5,000 no relationship to particle 5,000
 * in the next one, and the field scrambles on every change. Pinning the positions and only
 * recolouring is worse in a different way: every pose the subject ever occupies is inked at
 * once, so the arm appears in all three places simultaneously — ghosting, not motion.
 *
 * What actually works is displacement. Take the particles as they fall on frame 1, work out
 * where the picture moved between frame 1 and frame 2, and move each particle by that amount.
 * The dust that landed on the arm stays on the arm.
 *
 * Block matching rather than a gradient method: the frames come from an image model, so
 * brightness is not conserved between them and the usual optical-flow assumption doesn't hold.
 * Matching patches by appearance survives that; differentiating brightness does not.
 */

export interface FlowField {
  /** grid dimensions of the flow field */
  gw: number;
  gh: number;
  /** displacement per cell, in NORMALISED image units (fraction of width/height) */
  dx: Float32Array;
  dy: Float32Array;
}

interface Gray {
  w: number;
  h: number;
  v: Float32Array;
}

/** Downscale to luminance at a working resolution — full res buys nothing and costs a lot. */
export function toGray(data: Uint8ClampedArray, w: number, h: number, targetW = 240): Gray {
  const scale = Math.max(1, Math.round(w / targetW));
  const gw = Math.floor(w / scale);
  const gh = Math.floor(h / scale);
  const v = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      let sum = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const o = ((y * scale + sy) * w + (x * scale + sx)) * 4;
          sum += 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
        }
      }
      v[y * gw + x] = sum / (scale * scale * 255);
    }
  }
  return { w: gw, h: gh, v };
}

const BLOCK = 8; // patch size, in working-resolution pixels
const SEARCH = 12; // how far a patch is allowed to have moved
const SMOOTH_PASSES = 3;

/**
 * Match every block of `a` against `b` within a search window, then smooth the result.
 * Smoothing matters more than the match itself: raw block matching is noisy in flat regions,
 * and unsmoothed noise shows up as particles jittering in place.
 */
export function computeFlow(a: Gray, b: Gray): FlowField {
  const gw = Math.floor(a.w / BLOCK);
  const gh = Math.floor(a.h / BLOCK);
  const dx = new Float32Array(gw * gh);
  const dy = new Float32Array(gw * gh);

  for (let by = 0; by < gh; by += 1) {
    for (let bx = 0; bx < gw; bx += 1) {
      const ox = bx * BLOCK;
      const oy = by * BLOCK;
      let best = Infinity;
      let bestX = 0;
      let bestY = 0;
      for (let sy = -SEARCH; sy <= SEARCH; sy += 2) {
        for (let sx = -SEARCH; sx <= SEARCH; sx += 2) {
          let err = 0;
          for (let y = 0; y < BLOCK; y += 2) {
            for (let x = 0; x < BLOCK; x += 2) {
              const ax = ox + x;
              const ay = oy + y;
              const cx = Math.min(Math.max(ax + sx, 0), a.w - 1);
              const cy = Math.min(Math.max(ay + sy, 0), a.h - 1);
              err += Math.abs(a.v[ay * a.w + ax]! - b.v[cy * b.w + cx]!);
            }
          }
          // prefer the smaller motion when two candidates match equally well — without this
          // flat areas pick an arbitrary far-off patch and the field tears
          err += (Math.abs(sx) + Math.abs(sy)) * 0.0015;
          if (err < best) {
            best = err;
            bestX = sx;
            bestY = sy;
          }
        }
      }
      dx[by * gw + bx] = bestX / a.w;
      dy[by * gw + bx] = bestY / a.h;
    }
  }

  for (let p = 0; p < SMOOTH_PASSES; p += 1) {
    blur(dx, gw, gh);
    blur(dy, gw, gh);
  }
  return { gw, gh, dx, dy };
}

function blur(f: Float32Array, gw: number, gh: number): void {
  const src = f.slice();
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      let sum = 0;
      let n = 0;
      for (let j = -1; j <= 1; j += 1) {
        for (let i = -1; i <= 1; i += 1) {
          const cx = x + i;
          const cy = y + j;
          if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
          sum += src[cy * gw + cx]!;
          n += 1;
        }
      }
      f[y * gw + x] = sum / n;
    }
  }
}

/** Bilinear sample of the flow at a normalised image position (u, v both in 0..1). */
export function sampleFlow(flow: FlowField, u: number, v: number): [number, number] {
  const x = Math.min(Math.max(u * flow.gw - 0.5, 0), flow.gw - 1);
  const y = Math.min(Math.max(v * flow.gh - 0.5, 0), flow.gh - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, flow.gw - 1);
  const y1 = Math.min(y0 + 1, flow.gh - 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (f: Float32Array, ix: number, iy: number) => f[iy * flow.gw + ix]!;
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
  const sx = lerp(
    lerp(at(flow.dx, x0, y0), at(flow.dx, x1, y0), fx),
    lerp(at(flow.dx, x0, y1), at(flow.dx, x1, y1), fx),
    fy,
  );
  const sy = lerp(
    lerp(at(flow.dy, x0, y0), at(flow.dy, x1, y0), fx),
    lerp(at(flow.dy, x0, y1), at(flow.dy, x1, y1), fx),
    fy,
  );
  return [sx, sy];
}
