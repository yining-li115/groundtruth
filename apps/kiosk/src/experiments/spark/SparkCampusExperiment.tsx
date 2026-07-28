import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls } from "@sparkjsdev/spark";
import { dark } from "@groundtruth/tokens";
import { showreel } from "../../lib/content";
import autoTour from "./tour.json";

/**
 * Spark renderer trial (/?exp=spark) — step 1 of moving the campus gaussians off
 * @mkkellogg/gaussian-splats-3d and onto Spark (World Labs), so we can fly INSIDE the
 * scan instead of orbiting it from outside.
 *
 * What this page is for:
 *   1. judging DENSITY up close — `?asset=` switches between the shipped 400k decimated
 *      PLY and the full 1.82M SOG (same 21MB download, ~4.5x the splats);
 *   2. judging FRAME RATE with Spark's LoD on this hardware (HUD, top-left);
 *   3. CAPTURING WAYPOINTS — free-fly to a framing you like, press P to pin it, C to
 *      copy the whole list as JSON. Those pins become the auto-cycling viewpoints the
 *      showreel news attaches to.
 *
 * Controls: drag = look · WASD/arrows = fly · scroll = dolly · shift = 5x · [ ] = speed
 *           P = pin waypoint · C = copy JSON · X = clear · R = reset view
 *
 * Orientation note: the scan is stored Y-down (our old code compensated with
 * cameraUp = [0,-1,0]). Here the MESH is rotated 180° about X instead, so the world is
 * plain Y-up and free-fly controls behave the way a person expects.
 */

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
/**
 * Three density tiers of the SAME crop of the campus scan, so the quality question can be
 * answered by looking rather than arguing. The old pipeline decimated the source ~6x before
 * cropping — that, not the renderer, is why this read softer than the SuperSplat viewer.
 *   ?asset=web → what the kiosk ships today · ?asset=mid → same download, 4.5x the splats
 *   ?asset=max → the crop at FULL source density (what SuperSplat shows)
 */
/**
 * Density tiers of the SAME crop, in the SAME frame — waypoints captured on one tier replay
 * exactly on any other.
 *
 * Both SOG tiers are rebuilt straight from the 24.1M source with `-r 0,20.9,0` then the tuned
 * box. Two corrections went into that: the upright yaw is **20.9°**, not the 16.9° the splat
 * README records (recovered by correlating top-down height maps against the tuned ply — a
 * sharp peak, corr 0.998; 16.9° sliced a diagonal corner off the campus), and the box no
 * longer clamps Y, which is what had been flattening the clock tower's spire.
 */
const URLS = {
  mid: { url: "/splat/tum-campus.sog", label: "SOG · 1.8M splats · 21MB" },
  max: { url: "/splat/tum-campus-full.sog", label: "SOG · 13.0M splats · 147MB (full density)" },
  web: { url: "/splat/tum-campus-web.ply", label: "PLY · 400k · shipped today (clipped tower)" },
} as const;
type AssetKey = keyof typeof URLS;
const ASSET_PARAM = ((): AssetKey | null => {
  const a = PARAMS?.get("asset");
  return a === "web" || a === "mid" || a === "max" ? a : null;
})();
/** LoD costs a few seconds of worker time on load; `?lod=0` compares against raw,
 *  `?lod=quality` uses the slower/better bhatt-lod tree instead of the quick one. */
const LOD_PARAM = PARAMS?.get("lod");
const LOD_OPT: { lod?: boolean | "quality" } =
  LOD_PARAM === "0" ? {} : LOD_PARAM === "quality" ? { lod: "quality" } : { lod: true };

const num = (key: string, fallback: number) => {
  const v = Number(PARAMS?.get(key));
  return Number.isFinite(v) && PARAMS?.get(key) !== null ? v : fallback;
};
/**
 * Sharpness knobs. SuperSplat IS the PlayCanvas renderer, and Spark's docs say
 * `focalAdjustment: 2.0` reproduces PlayCanvas' splat scale calculation — Spark's own
 * default of 1.0 renders the same data visibly softer. That mismatch (not the data) is
 * half of why this looked worse than the SuperSplat viewer. Tunable live via URL:
 *   ?focal=2 &blur=0 &preblur=0 &stddev=2.83 &maxr=512
 */
const FOCAL_ADJUSTMENT = num("focal", 2.0);
const BLUR_AMOUNT = num("blur", 0.0);
const PRE_BLUR_AMOUNT = num("preblur", 0.0);
const MAX_STD_DEV = num("stddev", Math.sqrt(8));
/**
 * LoD budget in splats per FRAME — the real sharpness control, and the thing that decides
 * whether a denser asset buys anything at all. Loading 12.4M splats while capping this at 2M
 * renders about as much as the 1.8M tier does, so the big asset looks no better than the
 * small one. Default high enough that `asset=max` is actually worth loading; drop it with
 * ?budget= if the frame rate needs it. (Spark's own desktop default is 2.5M.)
 */
const LOD_SPLAT_COUNT = num("budget", 6_000_000);
/** Cone foveation — full detail within cone0, easing down to cone. Spark's defaults are
 *  90°/120°; tightening them buys frame rate but visibly softens everything off-centre,
 *  which is the wrong trade while judging quality. */
const CONE_FOV0 = num("cone0", 90);
const CONE_FOV = num("cone", 120);
/**
 * Render resolution. The old hero capped dpr at 1.5 as a kiosk perf budget, but on a
 * Retina panel that alone reads softer than SuperSplat (which renders at the full 2.0).
 * Default to the device's real dpr here so the comparison is honest; `?dpr=1.5` to see
 * what the perf-budgeted version costs in sharpness.
 */
const DPR_CAP = num("dpr", 1.5);
/** `?hud=1` shows the perf readout even on the unattended screen */
const SHOW_HUD = PARAMS?.get("hud") === "1";
/**
 * Adaptive LoD. Spark's contract is "never draw more than N splats a frame, so the frame
 * rate stays flat" — which only works if N suits the machine. Guessing one number for
 * unknown kiosk hardware gets it wrong in both directions, so steer N by measured frame
 * rate instead: give back detail while there is headroom, take it away when there isn't.
 * `?adapt=0` pins the budget for A/B comparisons.
 */
const ADAPT = PARAMS?.get("adapt") !== "0";
const TARGET_FPS = num("fps", 55);
const SCALE_MIN = 0.15;
const SCALE_MAX = 1.6;

/**
 * Per-asset extents, measured off the files themselves (`splat-transform --stats`); the scan
 * is stored Y-down. Used to frame the opening shot when `getBoundingBox()` can't help: under
 * LoD the mesh's splat source doesn't enumerate, so it hands back an empty box.
 */
const BOUNDS: Record<AssetKey, { min: [number, number, number]; max: [number, number, number] }> = {
  mid: { min: [-23, -10.77, -35], max: [26, 7.69, 26] },
  max: { min: [-23, -10.77, -35], max: [26, 7.69, 26] },
  web: { min: [-26, -8, -35], max: [23, 6.85, 26] }, // the old clipped crop
};

const START_SPEED = 12; // world-units/sec — the campus is ~100 units across
const SPEED_STEPS = [2, 4, 8, 12, 20, 35, 60];

interface Waypoint {
  /** "stop" = the camera pauses here and a news card attaches · "via" = pure path shaping,
   *  flown straight through (keeps the route out of the buildings). The auto-cycle is a
   *  CONTINUOUS flight — a Catmull-Rom spline through these positions with slerped
   *  orientation — never a cut between frames. */
  kind: "stop" | "via";
  pos: [number, number, number];
  /** camera quaternion — captured raw so a replay reproduces the framing exactly */
  quat: [number, number, number, number];
  /** vertical field of view in degrees, default DEFAULT_FOV. A pose that let the void into
   *  frame is corrected by tilting and/or reaching for a longer lens — never by moving the
   *  camera, since the position is the part a person actually chose. */
  fov?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Pins survive a reload — the asset kept changing under this page and a refresh used to
 *  silently throw away everything that had been pinned. */
/**
 * The built tour (scripts/build-tour.py): the hand-picked stops, with any pose that let the
 * void into frame nudged back onto the model, routed between stops through air that is both
 * reachable and above ground — the leg out of the courtyard ring arcs over the roofline.
 * Every waypoint carries the measured `fill` it was verified at.
 * Cast through unknown: JSON widens the tuples to number[].
 */
const AUTO_TOUR = autoTour as unknown as Waypoint[];

const STORE_KEY = "gt.spark.waypoints";
const loadPins = (): Waypoint[] => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? (v as Waypoint[]) : [];
  } catch {
    return [];
  }
};

/** auto-record drops a via every this many seconds of flying (only while actually moving) */
const RECORD_INTERVAL_S = 0.3;
const RECORD_MIN_MOVE = 0.5; // world units — don't spam vias while hovering in place
const DWELL_S = 2.5; // how long the flight rests on a "stop"
const CRUISE_SPEED = 6; // world units/sec along the spline
const MIN_LEG_S = 2.5; // even a short hop between stops gets time to read
const TURN_RATE = 0.6; // rad/sec — a stop that mostly turns in place still needs to pan slowly
/** the card rises over the last quarter of the approach, so it has settled on arrival */
const CARD_IN_FRACTION = 0.25;
/** How far across the screen the scrim reaches from the right edge. It has to run well past
 *  the text: a gradient that stops at the copy reads as a panel edge, and the point is for
 *  the darkening to be unnoticeable. Live-tunable with ?scrim=. */
const CARD_SCRIM_WIDTH = PARAMS?.get("scrim") ?? "78vw";
/** The copy owns the right half of the screen; the scrim runs wider still so its far edge
 *  falls off in the middle of the picture rather than behind the text. */
const CARD_WIDTH = PARAMS?.get("card") ?? "50vw";
/** Stops are matched to spotlights by order. The copy is placeholder, so an explicit anchor
 *  field on the content schema can wait until the real spotlights exist. */
const SPOTLIGHTS = showreel.filter((s) => s.kind === "spotlight");
const DEFAULT_FOV = 60;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Turn the pinned waypoints into a continuous flight: one Catmull-Rom curve through every
 * position (so vias bend the route instead of cutting it), with orientation slerped between
 * consecutive pins and a dwell at each stop. This is a preview of the real auto-cycle — the
 * camera flies there, it never cuts.
 */
function buildFlight(pins: Waypoint[]) {
  const points = pins.map((p) => new THREE.Vector3(...p.pos));
  const quats = pins.map((p) => new THREE.Quaternion(...p.quat));
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
  // u-boundaries by cumulative chord length, so speed stays even across the route
  const chords = points.slice(1).map((p, i) => p.distanceTo(points[i]!));
  const total = chords.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const uAt = [0, ...chords.map((c) => (acc += c) / total)];

  // One eased segment per STOP-to-STOP leg. Easing every waypoint pair instead would brake
  // and re-accelerate at each via — and vias exist to bend the route, not to punctuate it.
  const bounds = pins.reduce<number[]>((a, p, i) => (p.kind === "stop" ? [...a, i] : a), []);
  if (bounds[0] !== 0) bounds.unshift(0);
  if (bounds[bounds.length - 1] !== pins.length - 1) bounds.push(pins.length - 1);

  // A closed tour ends by landing back on the opening pose, so that trailing stop is stop 0
  // again — not a fifth one. Without this the card for the last leg would be off by one.
  const closed =
    bounds.length > 2 && points[bounds[bounds.length - 1]!]!.distanceTo(points[0]!) < 0.01;

  const segments = bounds.slice(1).map((b, k) => {
    const a = bounds[k]!;
    const dist = chords.slice(a, b).reduce((s, c) => s + c, 0);
    // Time the leg by whichever takes longer, travelling or turning. Two stops in the same
    // spot facing different ways are a pure pan, and pacing that by distance alone whips
    // the camera round in the minimum time.
    const turn = 2 * Math.acos(Math.min(1, Math.abs(quats[a]!.dot(quats[b]!))));
    return {
      a,
      b,
      u0: uAt[a]!,
      u1: uAt[b]!,
      duration: Math.max(dist / CRUISE_SPEED, turn / TURN_RATE, MIN_LEG_S),
      dwellAfter: pins[b]!.kind === "stop" ? DWELL_S : 0,
      /** which stop this leg arrives at — the card to show while it rests there */
      stop: closed && k === bounds.length - 2 ? 0 : k + 1,
    };
  });
  const fovs = pins.map((p) => p.fov ?? DEFAULT_FOV);
  const stopCount = closed ? bounds.length - 1 : bounds.length;
  return { curve, segments, quats, uAt, fovs, stopCount };
}

type Leg = { a: number; b: number; u0: number; u1: number };

/** which waypoint pair the flight is between, and how far across it */
function spanAt(flight: ReturnType<typeof buildFlight>, seg: Leg, e: number) {
  const u = seg.u0 + (seg.u1 - seg.u0) * e;
  let k = seg.a;
  while (k < seg.b - 1 && flight.uAt[k + 1]! < u) k += 1;
  const width = flight.uAt[k + 1]! - flight.uAt[k]!;
  const t = width > 1e-9 ? (u - flight.uAt[k]!) / width : 0;
  return { k, t: Math.min(1, Math.max(0, t)) };
}

/** orientation partway along a leg — slerped through the leg's via quaternions, which is
 *  where the mid-flight aiming corrections live, so they aren't skipped over */
function orientAt(
  flight: ReturnType<typeof buildFlight>,
  seg: Leg,
  e: number,
  out: THREE.Quaternion,
) {
  const { k, t } = spanAt(flight, seg, e);
  return out.copy(flight.quats[k]!).slerp(flight.quats[k + 1]!, t);
}

/** focal length partway along a leg — the lens eases with the move, so a stop that needs a
 *  longer lens to stay full-frame arrives already at it rather than snapping on arrival */
function fovAt(flight: ReturnType<typeof buildFlight>, seg: Leg, e: number) {
  const { k, t } = spanAt(flight, seg, e);
  const a = flight.fovs[k] ?? DEFAULT_FOV;
  return a + ((flight.fovs[k + 1] ?? DEFAULT_FOV) - a) * t;
}

export function CampusFlight({
  tools = true,
  autoPlay = false,
  asset = "mid",
}: {
  /** HUD, free-fly controls and the waypoint-pinning keys. Off for the unattended screen. */
  tools?: boolean;
  /** start the tour as soon as the splats are ready, and loop it forever */
  autoPlay?: boolean;
  /** density tier. `?asset=` overrides it, so the tool page can compare tiers on demand. */
  asset?: AssetKey;
} = {}) {
  const ASSET: AssetKey = ASSET_PARAM ?? asset;
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("loading…");
  const [fps, setFps] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(SPEED_STEPS.indexOf(START_SPEED));
  const [pins, setPins] = useState<Waypoint[]>(loadPins);
  const [readout, setReadout] = useState("");
  const [copied, setCopied] = useState(false);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [playInfo, setPlayInfo] = useState("");
  const [active, setActive] = useState(0);
  const [scale, setScale] = useState(1);
  /** which spotlight card is on screen, and how far it has risen (0..1) */
  const [card, setCard] = useState<{ stop: number; t: number } | null>(null);

  // persist every change, so a reload (or an asset swap) can't lose the picks
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(pins));
    } catch {
      /* private mode / quota — the on-screen JSON panel (J) is the fallback */
    }
  }, [pins]);

  // the render loop reads these without re-subscribing
  const pinsRef = useRef<Waypoint[]>([]);
  pinsRef.current = pins;
  const recordingRef = useRef(false);
  recordingRef.current = recording;
  /** live preview flight; non-null while playing */
  const playRef = useRef<{
    flight: ReturnType<typeof buildFlight>;
    i: number;
    t: number;
    phase: "fly" | "dwell";
  } | null>(null);

  // the loop writes these; React only reads them for the HUD
  const speedRef = useRef(START_SPEED);
  speedRef.current = SPEED_STEPS[speedIdx] ?? START_SPEED;
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const homeRef = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: false }); // Spark: AA off on purpose
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, DPR_CAP));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      host.clientWidth / host.clientHeight,
      0.1,
      2000,
    );
    cameraRef.current = camera;

    const spark = new SparkRenderer({
      renderer,
      focalAdjustment: FOCAL_ADJUSTMENT, // 2.0 = match PlayCanvas/SuperSplat sharpness
      blurAmount: BLUR_AMOUNT,
      preBlurAmount: PRE_BLUR_AMOUNT,
      maxStdDev: MAX_STD_DEV,
      lodSplatCount: LOD_SPLAT_COUNT,
      coneFov0: CONE_FOV0,
      coneFov: CONE_FOV,
    });
    scene.add(spark);

    const asset = URLS[ASSET];
    const splats = new SplatMesh({ url: asset.url, ...LOD_OPT });
    // stored Y-down → flip so the world is Y-up (see the orientation note above)
    splats.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
    scene.add(splats);

    const controls = new SparkControls({ canvas: renderer.domElement });

    const t0 = performance.now();
    splats.initialized
      .then(() => {
        if (disposed) return;
        // Open on the tour's first stop — that framing is the showreel's resting state, so
        // arriving anywhere else means the first thing a passer-by sees is a shot nobody
        // composed. Fall back to an overview of the whole block only if there is no tour.
        const opening = AUTO_TOUR[0];
        if (opening) {
          camera.position.set(...opening.pos);
          camera.quaternion.set(...opening.quat);
          camera.fov = opening.fov ?? DEFAULT_FOV;
          camera.updateProjectionMatrix();
        } else {
          // Under LoD the splat source doesn't enumerate, so getBoundingBox() hands back an
          // empty (inverted) box — fall back to the measured asset extents.
          let box = splats.getBoundingBox(true);
          if (!Number.isFinite(box.min.x) || box.isEmpty()) {
            const b = BOUNDS[ASSET];
            box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
          }
          splats.updateMatrixWorld(true);
          box.applyMatrix4(splats.matrixWorld); // the mesh is flipped Y-up; frame world-space
          const c = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const span = Math.max(size.x, size.z);
          camera.position.set(c.x + span * 0.55, c.y + size.y * 0.9 + span * 0.25, c.z + span * 0.55);
          camera.lookAt(c);
        }
        homeRef.current = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
        setStatus(
          `${asset.label} · LoD ${LOD_PARAM ?? "on"} · ${((performance.now() - t0) / 1000).toFixed(1)}s · ` +
            `focal ${FOCAL_ADJUSTMENT} · dpr ${DPR_CAP} · ` +
            `budget ${(LOD_SPLAT_COUNT / 1e6).toFixed(1)}M`,
        );
        if (autoPlay && AUTO_TOUR.length >= 2) {
          playRef.current = { flight: buildFlight(AUTO_TOUR), i: 0, t: 0, phase: "fly" };
          setPlaying(true);
        }
      })
      .catch((e: unknown) => {
        console.error("[spark] load failed", e);
        setStatus(`load FAILED — ${e instanceof Error ? e.message : String(e)}`);
      });

    let last = performance.now();
    let frames = 0;
    let fpsAt = last;
    let recordAcc = 0;
    const lastRecorded = new THREE.Vector3(Infinity, Infinity, Infinity);
    const tmpQ = new THREE.Quaternion();

    const tick = () => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const play = playRef.current;
      if (play) {
        // preview flight — drive the camera along the spline; manual controls stay off so
        // they can't fight it. Loops forever; Esc drops back to free-fly.
        const segs = play.flight.segments;
        const seg = segs[play.i];
        if (!seg) {
          playRef.current = null;
          setPlaying(false);
          setCard(null);
        } else {
          play.t += dt;
          if (play.phase === "fly") {
            const k = Math.min(1, play.t / seg.duration);
            const e = easeInOut(k);
            const p = play.flight.curve.getPointAt(seg.u0 + (seg.u1 - seg.u0) * e);
            // a degenerate spline segment yields NaN and would freeze the camera silently
            if (Number.isFinite(p.x)) camera.position.copy(p);
            camera.quaternion.copy(orientAt(play.flight, seg, e, tmpQ));
            const fov = fovAt(play.flight, seg, e);
            if (Math.abs(camera.fov - fov) > 0.01) {
              camera.fov = fov;
              camera.updateProjectionMatrix();
            }
            if (k >= 1) {
              play.t = 0;
              if (seg.dwellAfter > 0) play.phase = "dwell";
              else play.i = (play.i + 1) % segs.length;
            }
          } else if (play.t >= seg.dwellAfter) {
            play.t = 0;
            play.phase = "fly";
            play.i = (play.i + 1) % segs.length;
          }
          // The card belongs to the stop this leg lands on. Bring it in over the last stretch
          // of the approach so it is already settled when the camera stops, and take it away
          // the moment the camera leaves.
          const approach =
            play.phase === "dwell"
              ? 1
              : Math.max(0, (play.t / seg.duration - (1 - CARD_IN_FRACTION)) / CARD_IN_FRACTION);
          setCard(approach > 0 ? { stop: seg.stop % play.flight.stopCount, t: approach } : null);

          if (now - fpsAt >= 500) {
            const pct = play.phase === "fly" ? Math.min(1, play.t / seg.duration) : 1;
            setPlayInfo(
              `leg ${play.i + 1}/${segs.length} · ${play.phase}` +
                (play.phase === "fly"
                  ? ` ${Math.round(pct * 100)}% (${seg.duration.toFixed(1)}s)`
                  : ` ${(seg.dwellAfter - play.t).toFixed(1)}s left`),
            );
          }
        }
      } else if (tools) {
        controls.fpsMovement.moveSpeed = speedRef.current;
        controls.update(camera);

        // auto-record: while flying with recording on, drop a via every RECORD_INTERVAL_S.
        // Beats hand-placing vias for a route that has to climb over the ring of buildings
        // and back down the other side.
        if (recordingRef.current) {
          recordAcc += dt;
          if (
            recordAcc >= RECORD_INTERVAL_S &&
            camera.position.distanceTo(lastRecorded) >= RECORD_MIN_MOVE
          ) {
            recordAcc = 0;
            lastRecorded.copy(camera.position);
            const { x, y, z } = camera.position;
            const q = camera.quaternion;
            setPins((prev) => [
              ...prev,
              {
                kind: "via",
                pos: [r2(x), r2(y), r2(z)],
                quat: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)],
              },
            ]);
          }
        }
      }

      renderer.render(scene, camera);

      frames += 1;
      if (now - fpsAt >= 500) {
        const measured = Math.round((frames * 1000) / (now - fpsAt));
        setFps(measured);
        if (ADAPT) {
          // Nudge, don't jump: a big correction overshoots and the detail visibly pumps.
          // Shedding is quicker than recovering so a dip is caught before it reads as a stall.
          const s0 = spark.lodSplatScale ?? 1;
          const next =
            measured < TARGET_FPS - 5
              ? s0 * 0.85
              : measured > TARGET_FPS + 8
                ? s0 * 1.06
                : s0;
          spark.lodSplatScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
          setScale(spark.lodSplatScale);
        }
        frames = 0;
        fpsAt = now;
        const p = camera.position;
        setReadout(`${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}`);
        // splats actually drawn this frame — the number that decides how sharp it looks.
        // If this sits far below the asset's total, the LoD budget is the ceiling, not the data.
        setActive(spark.activeSplats ?? 0);
      }
      void dt;
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      splats.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [tools, autoPlay, ASSET]);

  // waypoint capture + speed keys, kept out of the render loop
  useEffect(() => {
    if (!tools) return;
    const onKey = (e: KeyboardEvent) => {
      const cam = cameraRef.current;
      const k = e.key.toLowerCase();
      if ((k === "p" || k === "o") && cam) {
        const { x, y, z } = cam.position;
        const q = cam.quaternion;
        setPins((prev) => [
          ...prev,
          {
            kind: k === "p" ? "stop" : "via",
            pos: [r2(x), r2(y), r2(z)],
            quat: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)],
          },
        ]);
      } else if (k === "z") {
        setPins((prev) => prev.slice(0, -1)); // undo the last pin
      } else if (k === "c") {
        setPins((prev) => {
          navigator.clipboard
            ?.writeText(JSON.stringify(prev, null, 2))
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => setShowJson(true)); // clipboard refused — show it instead
          return prev;
        });
      } else if (k === "j") {
        setShowJson((v) => !v); // readable/selectable fallback when the clipboard doesn't take
      } else if (k === "x") {
        setPins([]);
      } else if (k === "r" && cam && homeRef.current) {
        cam.position.copy(homeRef.current.pos);
        cam.quaternion.copy(homeRef.current.quat);
      } else if (k === "[") {
        setSpeedIdx((i) => Math.max(0, i - 1));
      } else if (k === "]") {
        setSpeedIdx((i) => Math.min(SPEED_STEPS.length - 1, i + 1));
      } else if (k === " ") {
        e.preventDefault(); // space would otherwise scroll/click-through
        setRecording((r) => !r);
      } else if (k === "t" || k === "y") {
        // T previews what's pinned; Y always plays the planned tour (scripts/plan-tour.py —
        // viewpoints chosen off the geometry, every frame filled by the model).
        const route = k === "y" || pinsRef.current.length < 2 ? AUTO_TOUR : pinsRef.current;
        if (route.length >= 2) {
          playRef.current = { flight: buildFlight(route), i: 0, t: 0, phase: "fly" };
          setPlaying(true);
        }
      } else if (k === "escape") {
        playRef.current = null;
        setPlaying(false);
        setRecording(false);
        setCard(null);
        if (cam && cam.fov !== DEFAULT_FOV) {
          cam.fov = DEFAULT_FOV; // hand free-fly back a normal lens
          cam.updateProjectionMatrix();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tools]);

  const panel: React.CSSProperties = {
    background: "rgb(0 0 0 / 0.55)",
    color: dark.text.primary,
    border: `1px solid ${dark.border}`,
    backdropFilter: "blur(6px)",
  };

  return (
    <div className="fixed inset-0" style={{ background: dark.bg }}>
      <div ref={hostRef} className="absolute inset-0" />

      {/* Spotlight card for the stop the flight is resting on. The campus fills the frame by
          design, so the copy sits over a scrim rather than a panel — the shot stays the
          picture, the text just has to stay legible on top of it. */}
      {card && SPOTLIGHTS[card.stop % SPOTLIGHTS.length] && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end"
          style={{
            width: CARD_SCRIM_WIDTH,
            background:
              "linear-gradient(to left, rgb(0 0 0 / 0.86) 0%, rgb(0 0 0 / 0.74) 30%," +
              " rgb(0 0 0 / 0.45) 62%, rgb(0 0 0 / 0.16) 84%, transparent 100%)",
            opacity: card.t,
          }}
        >
          <div
            className="pr-[4vw]"
            // eslint-disable-next-line react/forbid-dom-props -- width is URL-tunable
            style={{
              width: CARD_WIDTH,
              transform: `translateX(${(1 - card.t) * 40}px)`,
              filter: `blur(${(1 - card.t) * 6}px)`,
            }}
          >
            <div
              className="mb-4 text-sm font-bold uppercase tracking-[0.18em]"
              style={{ color: dark.accent }}
            >
              Spotlight {String((card.stop % SPOTLIGHTS.length) + 1).padStart(2, "0")} /{" "}
              {String(SPOTLIGHTS.length).padStart(2, "0")}
            </div>
            <h2
              className="text-6xl font-bold leading-[1.04] tracking-tight"
              style={{ color: dark.text.primary }}
            >
              {SPOTLIGHTS[card.stop % SPOTLIGHTS.length]!.title}
            </h2>
            <p className="mt-6 max-w-[38rem] text-xl leading-snug" style={{ color: dark.text.secondary }}>
              {SPOTLIGHTS[card.stop % SPOTLIGHTS.length]!.blurb}
            </p>
          </div>
        </div>
      )}

      {/* Perf/quality readout. Normally part of the tool layer, but `?hud=1` brings it back on
          the unattended screen too — checking what the wall is actually drawing shouldn't
          require opening a different page. */}
      {(tools || SHOW_HUD) && (
        <div
          className="absolute left-4 top-4 rounded-lg px-3 py-2 font-mono text-xs leading-relaxed"
          style={panel}
        >
          <div>
            <span style={{ color: fps >= 50 ? dark.accent : dark.text.secondary }}>{fps} fps</span>
            {"  ·  drawing "}
            <span style={{ color: dark.accent }}>{(active / 1e6).toFixed(2)}M</span>
            {" splats/frame"}
            {ADAPT ? ` · lod ×${scale.toFixed(2)}` : " · lod fixed"}
          </div>
          <div style={{ color: dark.text.secondary }}>{status}</div>
        </div>
      )}

      {/* Everything below is the TOOL layer — key help, pin list, JSON dump. It must stay
          off the unattended screen: the wall is a finished picture, not a workbench. */}
      {tools && (
        <>
      <div
        className="absolute left-4 top-20 rounded-lg px-3 py-2 font-mono text-xs leading-relaxed"
        style={panel}
      >
        <div style={{ color: dark.text.secondary }}>speed {speedRef.current} · cam {readout}</div>
        {(recording || playing) && (
          <div style={{ color: dark.accent }}>
            {recording ? "● RECORDING PATH" : ""}
            {recording && playing ? " · " : ""}
            {playing ? `▶ ${playInfo}` : ""}
          </div>
        )}
      </div>

      {/* key help — bottom-left */}
      <div
        className="absolute bottom-4 left-4 rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed"
        style={{ ...panel, color: dark.text.secondary }}
      >
        drag look · WASD fly · scroll dolly · shift 5× · [ ] speed
        <br />
        <b style={{ color: dark.text.primary }}>P</b> pin STOP (news here) ·{" "}
        <b style={{ color: dark.text.primary }}>O</b> pin VIA (fly through) ·{" "}
        <b style={{ color: dark.text.primary }}>Z</b> undo
        <br />
        <b style={{ color: dark.text.primary }}>Space</b> record path (auto-vias while you fly) ·{" "}
        <b style={{ color: dark.text.primary }}>T</b> preview flight ·{" "}
        <b style={{ color: dark.text.primary }}>Esc</b> stop
        <br />
        <b style={{ color: dark.text.primary }}>C</b> copy JSON ·{" "}
        <b style={{ color: dark.text.primary }}>J</b> show JSON ·{" "}
        <b style={{ color: dark.text.primary }}>X</b> clear ·{" "}
        <b style={{ color: dark.text.primary }}>R</b> reset view
        <br />
        <span>pins are saved across reloads</span>
        <br />
        <span>?asset=web|mid|max · ?lod=0|quality · ?focal=1|2 · ?dpr=1|1.5|2 · ?budget=4000000</span>
      </div>

      {/* raw JSON, selectable — the reliable way to get the picks out of the browser */}
      {showJson && (
        <textarea
          readOnly
          value={JSON.stringify(pins, null, 1)}
          onFocus={(e) => e.currentTarget.select()}
          className="absolute left-1/2 top-1/2 h-[70vh] w-[46rem] -translate-x-1/2 -translate-y-1/2 rounded-lg p-3 font-mono text-[11px]"
          style={{ ...panel, color: dark.text.primary, resize: "none" }}
        />
      )}

      {/* captured waypoints — right */}
      {pins.length > 0 && (
        <div
          className="absolute right-4 top-4 max-h-[80vh] overflow-auto rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed"
          style={panel}
        >
          <div style={{ color: dark.accent }}>
            {pins.length} waypoint{pins.length > 1 ? "s" : ""}
            {copied ? " — copied ✓" : ""}
          </div>
          {pins.map((p, i) => (
            <div key={i} style={{ color: dark.text.secondary }}>
              <span style={{ color: p.kind === "stop" ? dark.accent : dark.text.secondary }}>
                {p.kind === "stop" ? "■ stop" : "· via "}
              </span>{" "}
              [{p.pos.join(", ")}]
            </div>
          ))}
        </div>
      )}
        </>
      )}
    </div>
  );
}

/** `/?exp=spark` — the same flight with the tool layer on: HUD, free-fly, waypoint pinning. */
export function SparkCampusExperiment() {
  return <CampusFlight tools autoPlay={false} />;
}
