import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SparkControls } from "@sparkjsdev/spark";
import { dark } from "@groundtruth/tokens";
import { showreel } from "../../lib/content";
import {
  flightInput,
  setSceneAvailability,
  type SceneEndReason,
} from "../../lib/vision/flightInput";
import { HandSkeleton } from "../../components/HandSkeleton";
import { SKY_ENABLED, createSkyDome, type SkyDome } from "./sky";
import {
  DEFAULT_SCENE_NAVIGATION,
  SceneNavigationController,
  sceneSampleIsFresh,
  type SceneNavigationConfig,
} from "./sceneNavigation";
import {
  buildProductionTourCurve,
  inspectCameraCurveInRoam,
  inspectCurveInRoam,
  isRoamableSphere,
  PRODUCTION_CAMERA_RADIUS,
  routeTourThroughRoam,
  type RoamVolume,
  type TourWaypoint as Waypoint,
} from "./safeTour";
import autoTour from "./tour.json";
import roamVolume from "./roam.json";
import {
  DEFAULT_GAUSSIAN_DPR_CAP,
  DEFAULT_GAUSSIAN_SPLAT_BUDGET,
} from "./quality";
import {
  createPlayCanvasCampusRenderer,
  type PlayCanvasCampusRenderer,
} from "./playCanvasRenderer";

/**
 * Campus renderer and authoring route (/?exp=spark). The route name is retained for existing
 * authoring links, while the production model now uses the official SuperSplat
 * PlayCanvas/WebGPU renderer and Streamed SOG data.
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
  local: {
    url: "/splat/tum-campus-stream/lod-meta.json",
    label: "Streamed SOG · 13.0M top LOD (local full density)",
  },
  mid: { url: "/splat/tum-campus.sog", label: "SOG · 1.8M splats · 21MB" },
  max: { url: "/splat/tum-campus-full.sog", label: "SOG · 13.0M splats · 147MB (full density)" },
  web: { url: "/splat/tum-campus-web.ply", label: "PLY · 400k · shipped today (clipped tower)" },
} as const;
type AssetKey = keyof typeof URLS;
const ASSET_PARAM = ((): AssetKey | null => {
  const a = PARAMS?.get("asset");
  return a === "web" || a === "mid" || a === "local" || a === "max" ? a : null;
})();
const num = (key: string, fallback: number) => {
  const v = Number(PARAMS?.get(key));
  return Number.isFinite(v) && PARAMS?.get(key) !== null ? v : fallback;
};
/**
 * Global Streamed-SOG budget. PlayCanvas distributes it spatially according to the current
 * camera instead of thinning the entire campus uniformly. The URL value remains expressed in
 * individual splats for compatibility with the existing authoring links.
 */
const LOD_SPLAT_COUNT = num("budget", DEFAULT_GAUSSIAN_SPLAT_BUDGET);
/**
 * Render resolution. The old hero capped dpr at 1.5 as a kiosk perf budget, but on a
 * Retina panel that alone reads softer than SuperSplat (which renders at the full 2.0).
 * Default to the device's real dpr here so the comparison is honest; `?dpr=1.5` to see
 * what the perf-budgeted version costs in sharpness.
 */
const DPR_CAP = num("dpr", DEFAULT_GAUSSIAN_DPR_CAP);
/**
 * `?look=<yawDeg>,<pitchDeg>` — nudge the opening pose before anything else runs.
 *
 * Framing questions ("is there sky up there, and does it meet the rooflines properly?") can
 * only be answered by looking, and every stop in the tour was composed to be completely filled
 * by the model — so the poses that expose the sky are exactly the ones nothing lands on by
 * itself. Driving the free-fly controls from a headless screenshot is not possible; a URL is.
 * Purely a viewing aid: it moves nothing else, and the tour plays on from wherever it puts you.
 */
const LOOK_OFFSET = ((): { yaw: number; pitch: number } | null => {
  const raw = PARAMS?.get("look");
  if (!raw) return null;
  const [y, p] = raw.split(",").map(Number);
  if (!Number.isFinite(y ?? NaN)) return null;
  return { yaw: y ?? 0, pitch: Number.isFinite(p ?? NaN) ? (p ?? 0) : 0 };
})();

function applyLookOffset(camera: THREE.Camera): void {
  if (!LOOK_OFFSET) return;
  const yaw = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(LOOK_OFFSET.yaw),
  );
  const pitch = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    THREE.MathUtils.degToRad(LOOK_OFFSET.pitch),
  );
  // world yaw first, then pitch in the camera's own frame — the same order the hand control
  // uses, so what you see here is what a visitor could reach.
  camera.quaternion.premultiply(yaw).multiply(pitch);
}

/** `?hud=1` shows the perf readout even on the unattended screen */
const SHOW_HUD = PARAMS?.get("hud") === "1";
/**
 * Hand-driven camera speed, in world units/sec. One unit is roughly 3 m, which is what made
 * the first numbers wrong by an order of magnitude: 5 u/s of panning is 15 m/s, a car going
 * past a façade, not someone reading it. These are a brisk walk and a jog respectively.
 */
const SCENE_INPUT_TTL_MS = num("scenettl", 180);
const SCENE_CONFIG: SceneNavigationConfig = {
  ...DEFAULT_SCENE_NAVIGATION,
  yawGain: num("lookyaw", DEFAULT_SCENE_NAVIGATION.yawGain),
  pitchGain: num("lookpitch", DEFAULT_SCENE_NAVIGATION.pitchGain),
  lookDeadzone: num("lookdead", DEFAULT_SCENE_NAVIGATION.lookDeadzone),
  lookFilterTau: num("looktau", DEFAULT_SCENE_NAVIGATION.lookFilterTau),
  pitchLimit: THREE.MathUtils.degToRad(
    num("pitchlimit", THREE.MathUtils.radToDeg(DEFAULT_SCENE_NAVIGATION.pitchLimit)),
  ),
  exploreYawRate: num("exploreyaw", DEFAULT_SCENE_NAVIGATION.exploreYawRate),
  moveDeadzone: num("movedead", DEFAULT_SCENE_NAVIGATION.moveDeadzone),
  moveFullScale: num("movefull", DEFAULT_SCENE_NAVIGATION.moveFullScale),
  moveExponent: num("movecurve", DEFAULT_SCENE_NAVIGATION.moveExponent),
  dollySpeed: num("handdolly", DEFAULT_SCENE_NAVIGATION.dollySpeed),
  strafeSpeed: num("handstrafe", DEFAULT_SCENE_NAVIGATION.strafeSpeed),
  accelerationTau: num("handaccel", DEFAULT_SCENE_NAVIGATION.accelerationTau),
  range: num("handrange", DEFAULT_SCENE_NAVIGATION.range),
  holdMs: num("returnhold", DEFAULT_SCENE_NAVIGATION.holdMs),
  returnSpeed: num("returnspeed", DEFAULT_SCENE_NAVIGATION.returnSpeed),
  returnTurnRate: num("returnturn", DEFAULT_SCENE_NAVIGATION.returnTurnRate),
  flingWindowMs: num("flingwindow", DEFAULT_SCENE_NAVIGATION.flingWindowMs),
  flingMinRate: num("flingmin", DEFAULT_SCENE_NAVIGATION.flingMinRate),
  flingMaxRate: num("flingmax", DEFAULT_SCENE_NAVIGATION.flingMaxRate),
  flingTau: num("flingtau", DEFAULT_SCENE_NAVIGATION.flingTau),
  flingMaxAngle: num("flingangle", DEFAULT_SCENE_NAVIGATION.flingMaxAngle),
};
const MAX_TARGET_FPS = num("fps", 55);

/**
 * Per-asset extents, measured off the files themselves (`splat-transform --stats`); the scan
 * is stored Y-down. Used to frame the opening shot when `getBoundingBox()` can't help: under
 * LoD the mesh's splat source doesn't enumerate, so it hands back an empty box.
 */
const BOUNDS: Record<AssetKey, { min: [number, number, number]; max: [number, number, number] }> = {
  local: { min: [-23, -10.77, -35], max: [26, 7.69, 26] },
  mid: { min: [-23, -10.77, -35], max: [26, 7.69, 26] },
  max: { min: [-23, -10.77, -35], max: [26, 7.69, 26] },
  web: { min: [-26, -8, -35], max: [23, 6.85, 26] }, // the old clipped crop
};

const START_SPEED = 12; // world-units/sec — the campus is ~100 units across
const SPEED_STEPS = [2, 4, 8, 12, 20, 35, 60];

/** what the current gesture is doing — shown under the skeleton so the vocabulary is
 *  discoverable without a sign on the wall */
/**
 * Where a visitor is allowed to fly, as a coarse occupancy grid built by
 * scripts/build-roam-volume.py: the open air connected to the tour's stops, under the
 * roofline, and a clearance above the local ground. Clamping to a box alone can't express
 * this — a box that contains the courtyard also contains the buildings around it, so pushing
 * down or sideways would bury the camera in a wall. Testing the actual cell makes collision
 * against this measured coarse proxy an enforced runtime rule. It is not a watertight promise
 * about every rendered Gaussian: the current builder classifies splat centres, not complete
 * oriented ellipsoids. Visitor motion tests the full production camera sphere against that
 * grid; point occupancy remains only an offline routing primitive for voxel-centre paths.
 */
const ROAM: RoamVolume = {
  cell: roamVolume.cell,
  min: roamVolume.min as [number, number, number],
  dims: roamVolume.dims as [number, number, number],
  free: roamVolume.free,
};
function isCameraRoamable(x: number, y: number, z: number) {
  return isRoamableSphere(ROAM, x, y, z, PRODUCTION_CAMERA_RADIUS);
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
// The authored framing is preserved, but its old Catmull-Rom interpolation cut across cells
// that MOVE correctly classed as occupied. Route the between-pose vias through the exact same
// occupancy volume so taking over at an arbitrary tour frame can never start inside a wall.
const AUTO_TOUR = routeTourThroughRoam(autoTour as unknown as Waypoint[], ROAM);

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
/** How long the flight rests on a "stop". This is reading time, not pacing: the card that
 *  arrives with the stop is a headline plus three or four lines of news, and 2.5s was not
 *  enough to finish one from across a corridor. */
const DWELL_S = 5;
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
/** Stops are matched to cards by order. Every showreel item, not just `kind: "spotlight"` —
 *  filtering to one kind was fine while the other five were placeholder copy, but now that
 *  they are the group's actual news the idle wall should cycle all of them. (An explicit
 *  anchor field, pinning a given card to a given viewpoint, can still come later.) */
const CARDS = showreel;
const KIND_LABEL: Record<string, string> = {
  spotlight: "Spotlight",
  news: "News",
  "open-topic": "Open position",
};
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
  const curve = buildProductionTourCurve(pins);
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

const AUTO_FLIGHT = buildFlight(AUTO_TOUR);
const AUTO_FLIGHT_ROAM = inspectCurveInRoam(AUTO_FLIGHT.curve, ROAM);
const AUTO_FLIGHT_CAMERA_ROAM = inspectCameraCurveInRoam(
  AUTO_FLIGHT.curve,
  ROAM,
  PRODUCTION_CAMERA_RADIUS,
);
if (!AUTO_FLIGHT_ROAM.ok || !AUTO_FLIGHT_CAMERA_ROAM.ok) {
  const point = AUTO_FLIGHT_CAMERA_ROAM.firstBlocked ?? AUTO_FLIGHT_ROAM.firstBlocked;
  throw new Error(
    `Safe tour construction lacks camera clearance at ${point?.x.toFixed(2)},` +
      `${point?.y.toFixed(2)},${point?.z.toFixed(2)}`,
  );
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
  handControl = false,
  visitorPresent = false,
}: {
  /** HUD, free-fly controls and the waypoint-pinning keys. Off for the unattended screen. */
  tools?: boolean;
  /** start the tour as soon as the splats are ready, and loop it forever */
  autoPlay?: boolean;
  /** density tier. `?asset=` overrides it, so the tool page can compare tiers on demand. */
  asset?: AssetKey;
  /** consume the one global, routed scene intent published by HandControl */
  handControl?: boolean;
  /**
   * A fresh stable owner is in frame. Production uses this to freeze the attract/news tour
   * before the first navigation sample, and to keep the visitor's view parked while their open
   * hand crosses UI. It never authorizes motion; `flightInput.active` remains that boundary.
   */
  visitorPresent?: boolean;
} = {}) {
  const ASSET: AssetKey = ASSET_PARAM ?? asset;
  const globalFlight = useRef(flightInput);
  const hand = globalFlight;
  const visitorPresentRef = useRef(visitorPresent);
  visitorPresentRef.current = visitorPresent;
  const [handVisible, setHandVisible] = useState(false);
  /** true from the moment a hand takes over until the camera has drifted back to the tour —
   *  the spotlight card belongs to the tour's composed shot, not to whatever the visitor is
   *  pointing at, so it steps aside for the whole interaction */
  const [interacting, setInteracting] = useState(false);
  useEffect(() => {
    if (!handControl) return;
    const id = setInterval(() => {
      setHandVisible(hand.current.hands.length > 0);
    }, 120);
    return () => clearInterval(id);
  }, [handControl, hand]);
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
  const [dpr, setDpr] = useState(() => Math.min(window.devicePixelRatio, DPR_CAP));
  const [fpsTarget, setFpsTarget] = useState(() => Math.min(MAX_TARGET_FPS, 54));
  const [collisionBlocked, setCollisionBlocked] = useState(false);
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
    if (handControl) {
      setSceneAvailability("loading");
    }
    const navigation = new SceneNavigationController(SCENE_CONFIG);
    let campusRenderer: PlayCanvasCampusRenderer | null = null;
    let controls: SparkControls | null = null;
    const deviceDprCap = Math.min(window.devicePixelRatio, DPR_CAP);
    const camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      host.clientWidth / host.clientHeight,
      0.1,
      2000,
    );
    cameraRef.current = camera;
    const asset = URLS[ASSET];

    // Keep the existing analytic sky byte-for-byte and camera-for-camera. It renders into an
    // independent bottom canvas; the PlayCanvas model canvas is transparent above it. This
    // isolates the renderer migration to the Gaussian model instead of silently changing the
    // environment whenever a visitor looks above the captured geometry.
    const skyScene = new THREE.Scene();
    let skyRenderer: THREE.WebGLRenderer | null = null;
    let skyDome: SkyDome | null = null;
    if (SKY_ENABLED) {
      try {
        skyRenderer = new THREE.WebGLRenderer({ antialias: false });
        skyRenderer.setPixelRatio(deviceDprCap);
        skyRenderer.setSize(host.clientWidth, host.clientHeight);
        skyRenderer.domElement.style.position = "absolute";
        skyRenderer.domElement.style.inset = "0";
        skyRenderer.domElement.style.width = "100%";
        skyRenderer.domElement.style.height = "100%";
        skyRenderer.domElement.style.pointerEvents = "none";
        skyRenderer.domElement.setAttribute("aria-hidden", "true");
        host.appendChild(skyRenderer.domElement);
        skyDome = createSkyDome();
        skyScene.add(skyDome.object);
      } catch (error) {
        skyRenderer?.dispose();
        skyRenderer?.domElement.remove();
        cameraRef.current = null;
        if (handControl) setSceneAvailability("failed");
        setStatus(`sky setup FAILED — ${error instanceof Error ? error.message : String(error)}`);
        console.error("[showreel-sky] setup failed", error);
        return;
      }
    }

    let ready = false;
    let renderFailed = false;
    let rejectThroughSessionId = flightInput.sessionId;
    const failRender = (error: unknown) => {
      if (disposed || renderFailed) return;
      renderFailed = true;
      ready = false;
      cancelAnimationFrame(raf);
      navigation.reset();
      if (handControl) setSceneAvailability("failed");
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`render FAILED — ${message}`);
      console.error("[showreel-renderer] render failed", error);
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      failRender(new Error("Graphics context lost"));
    };
    skyRenderer?.domElement.addEventListener("webglcontextlost", onContextLost);
    const renderFrame = () => {
      try {
        skyRenderer?.render(skyScene, camera);
        campusRenderer?.syncCamera(camera);
        campusRenderer?.requestFrame();
      } catch (error) {
        failRender(error);
      }
    };

    const t0 = performance.now();
    const finishLoading = () => {
        if (disposed || renderFailed) return;
        // Open on the tour's first stop — that framing is the showreel's resting state, so
        // arriving anywhere else means the first thing a passer-by sees is a shot nobody
        // composed. Fall back to an overview of the whole block only if there is no tour.
        const opening = AUTO_TOUR[0];
        if (opening) {
          camera.position.set(...opening.pos);
          camera.quaternion.set(...opening.quat);
          camera.fov = opening.fov ?? DEFAULT_FOV;
          camera.updateProjectionMatrix();
          applyLookOffset(camera);
        } else {
          const b = BOUNDS[ASSET];
          const box = new THREE.Box3(
            new THREE.Vector3(b.min[0], -b.max[1], -b.max[2]),
            new THREE.Vector3(b.max[0], -b.min[1], -b.min[2]),
          );
          const c = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const span = Math.max(size.x, size.z);
          camera.position.set(c.x + span * 0.55, c.y + size.y * 0.9 + span * 0.25, c.z + span * 0.55);
          camera.lookAt(c);
        }
        homeRef.current = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
        ready = true;
        if (handControl) {
          // A grip that began against the loading/default camera must never wake up later and
          // capture that pose. Only a session beginning after the composed opening is installed
          // may take ownership.
          rejectThroughSessionId = flightInput.sessionId;
          setSceneAvailability("ready");
        }
        frames = 0;
        fpsAt = performance.now();
        setStatus(
          `${asset.label} · PlayCanvas WebGPU/Streamed SOG · ` +
            `${((performance.now() - t0) / 1000).toFixed(1)}s · ` +
            `budget ${(LOD_SPLAT_COUNT / 1e6).toFixed(1)}M`,
        );
        if (autoPlay && AUTO_TOUR.length >= 2) {
          playRef.current = { flight: AUTO_FLIGHT, i: 0, t: 0, phase: "fly" };
          setPlaying(true);
        }
        renderFrame();
    };

    void createPlayCanvasCampusRenderer({
      host,
      contentUrl: asset.url,
      budgetMillions: LOD_SPLAT_COUNT / 1_000_000,
      interactiveCanvas: tools,
      onProgress: (progress) => setStatus(`loading model… ${Math.round(progress)}%`),
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        campusRenderer = created;
        created.canvas.addEventListener("webglcontextlost", onContextLost);
        // The authoring route keeps its existing mouse/WASD controller. Production never
        // constructs it, so the official viewer remains a pure renderer behind hand input.
        controls = tools ? new SparkControls({ canvas: created.canvas }) : null;
        created.syncCamera(camera);
        return created.loaded.then(finishLoading);
      })
      .catch((e: unknown) => {
        // StrictMode deliberately mounts, disposes and mounts again in development. A late
        // rejection from the disposed first instance has no authority to turn off the live
        // second instance's global scene input or overwrite its status.
        if (disposed) return;
        console.error("[playcanvas] load failed", e);
        if (handControl) {
          setSceneAvailability("failed");
        }
        setStatus(`load FAILED — ${e instanceof Error ? e.message : String(e)}`);
      });

    let last = performance.now();
    let frames = 0;
    let fpsAt = last;
    let recordAcc = 0;
    const lastRecorded = new THREE.Vector3(Infinity, Infinity, Infinity);
    const tmpQ = new THREE.Quaternion();
    let reportedInteracting = false;
    let reportedBlocked = false;
    let acceptedOwnerId: number | null = null;
    const refreshIntervals: number[] = [];
    let refreshTarget = Math.min(MAX_TARGET_FPS, 54);

    const tick = () => {
      if (disposed || renderFailed) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const elapsedMs = now - last;
      const abnormalFrameGap = elapsedMs > 120;
      // Preserve real-time speed down to 10fps; SceneNavigationController divides this into
      // bounded physics steps. Clamping at 50ms made the same gesture 25% slower at 15fps.
      const dt = abnormalFrameGap ? 0 : Math.min(elapsedMs / 1000, 0.1);
      last = now;

      // Preserve the pre-migration sky behaviour: the Munich sun is recomputed once a minute.
      skyDome?.update(now);

      // Learn the display ceiling rather than assuming every screen is 60Hz. A 30Hz panel
      // should target ~27fps, not be permanently classified as overloaded against a 55fps bar.
      if (elapsedMs >= 4 && elapsedMs <= 60 && refreshIntervals.length < 90) {
        refreshIntervals.push(elapsedMs);
        if (refreshIntervals.length === 45 || refreshIntervals.length === 90) {
          const ordered = [...refreshIntervals].sort((a, b) => a - b);
          const interval = ordered[Math.floor(ordered.length * 0.2)] ?? 1000 / 60;
          const ceiling = 1000 / interval;
          refreshTarget = Math.min(MAX_TARGET_FPS, Math.max(20, ceiling * 0.9));
          setFpsTarget(Math.round(refreshTarget));
        }
      }

      // The scene sees only a router-owned session. Presence, cursor position and UI presses
      // cannot enter this branch. Both producer and consumer enforce freshness so a frozen tab,
      // stalled decoder or lost hand stops on the first stale frame.
      const h = hand.current;
      // Presence decides who owns the showreel lifecycle, but never authorizes movement. The
      // routed scene session below is still the sole camera writer. This distinction lets an
      // open hand freeze the news immediately while UI hover / a fist safely holds the view.
      const visitor = handControl && visitorPresentRef.current;
      const before = navigation.status;
      const fresh = sceneSampleIsFresh(
        h.freshAt,
        now,
        Math.max(SCENE_INPUT_TTL_MS, h.freshForMs),
      );
      const continuingAcceptedSession =
        before.phase === "grab" &&
        before.sessionId === h.sessionId &&
        acceptedOwnerId === h.ownerId;
      const eligible =
        handControl &&
        ready &&
        h.ready &&
        h.active &&
        h.ownerId !== null &&
        (continuingAcceptedSession || h.sessionId > rejectThroughSessionId) &&
        fresh &&
        !abnormalFrameGap;

      // A newly published session can replace the old one between two display frames. End
      // the old clutch first instead of leaving it stuck in `grab` while its mismatched
      // updates are ignored. The next display frame may accept the newer session because we
      // reject only through the session we actually consumed.
      if (before.phase === "grab" && h.active && !continuingAcceptedSession) {
        rejectThroughSessionId = Math.max(rejectThroughSessionId, before.sessionId);
        navigation.end(camera, "owner-changed", now);
      } else if (eligible) {
        if (navigation.status.phase !== "grab") {
          acceptedOwnerId = h.ownerId;
          rejectThroughSessionId = Math.max(rejectThroughSessionId, h.sessionId);
          navigation.begin(camera, {
            sessionId: h.sessionId,
            seq: h.seq,
            mode: h.mode,
            dx: h.dx,
            dy: h.dy,
            at: h.freshAt,
          });
        }
        navigation.update(
          camera,
          {
            sessionId: h.sessionId,
            seq: h.seq,
            mode: h.mode,
            dx: h.dx,
            dy: h.dy,
            at: h.freshAt,
          },
          dt,
          isCameraRoamable,
        );
      } else if (before.phase === "grab") {
        let reason: SceneEndReason = h.endReason ?? "cancelled";
        if (abnormalFrameGap || (h.active && !fresh)) reason = "stale";
        else if (h.active && acceptedOwnerId !== h.ownerId) reason = "owner-changed";
        else if (!ready || !h.ready) reason = "scene-unavailable";
        rejectThroughSessionId = Math.max(rejectThroughSessionId, h.sessionId);
        navigation.end(
          camera,
          reason,
          now,
          reason === "released" && Number.isFinite(h.freshAt) ? h.freshAt : now,
        );
      }

      // While the visitor is still in frame, a released/paused Explore stays exactly where
      // they left it. Only losing the stable hand starts the breadcrumb return; the tour cannot
      // resume until that safe return reaches its original composed pose.
      if (navigation.status.phase !== "grab" && !visitor) {
        navigation.tick(camera, dt, now, isCameraRoamable);
      }
      const navStatus = navigation.status;
      const showreelTakenOver = visitor || navStatus.interacting;
      if (showreelTakenOver !== reportedInteracting) {
        reportedInteracting = showreelTakenOver;
        setInteracting(reportedInteracting);
      }
      if (navStatus.blocked !== reportedBlocked) {
        reportedBlocked = navStatus.blocked;
        setCollisionBlocked(reportedBlocked);
      }

      const play = playRef.current;
      if (play && !visitor && !navStatus.interacting) {
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
            // The shared offline invariant samples this exact curve, but the render-time guard
            // is the final authority: a future route/curve edit must never leave the camera in
            // a blocked voxel that an arriving visitor cannot move out of. Freeze on the last
            // safe pose and surface a real scene failure instead of offering broken Explore.
            if (
              !Number.isFinite(p.x) ||
              !Number.isFinite(p.y) ||
              !Number.isFinite(p.z) ||
              !isCameraRoamable(p.x, p.y, p.z)
            ) {
              failRender(new Error("Automatic tour left the safe roam volume"));
              return;
            }
            camera.position.copy(p);
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
          const cardStop = seg.stop % play.flight.stopCount;
          setCard((previous) => {
            if (approach <= 0) return previous === null ? previous : null;
            if (
              previous?.stop === cardStop &&
              (approach === 1 ? previous.t === 1 : Math.abs(previous.t - approach) < 0.015)
            ) {
              return previous;
            }
            return { stop: cardStop, t: approach };
          });

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
      } else if (play && (visitor || navStatus.interacting)) {
        // The tour/news clock freezes as soon as a stable hand appears, then stays frozen until
        // any displaced camera has safely retraced to the composed pose after that hand leaves.
      } else if (tools) {
        if (controls) {
          controls.fpsMovement.moveSpeed = speedRef.current;
          controls.update(camera);
        }

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

      renderFrame();

      frames += 1;
      if (now - fpsAt >= 500) {
        const measured = Math.round((frames * 1000) / (now - fpsAt));
        setFps(measured);
        setDpr(deviceDprCap);
        frames = 0;
        fpsAt = now;
        const p = camera.position;
        setReadout(`${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}`);
      }
      void dt;
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      skyRenderer?.setPixelRatio(Math.min(window.devicePixelRatio, DPR_CAP));
      skyRenderer?.setSize(host.clientWidth, host.clientHeight);
      setDpr(Math.min(window.devicePixelRatio, DPR_CAP));
      renderFrame();
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      // Keep a real failure visible when React removes the failed scene (for example after a
      // lazy/error-boundary rejection). A normal route teardown may publish unavailable, but
      // it must not erase the diagnosis before ShowreelFlight can render it.
      if (handControl && flightInput.availability !== "failed") {
        setSceneAvailability("unavailable");
      }
      navigation.reset();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      skyRenderer?.domElement.removeEventListener("webglcontextlost", onContextLost);
      campusRenderer?.canvas.removeEventListener("webglcontextlost", onContextLost);
      campusRenderer?.dispose();
      campusRenderer = null;
      skyDome?.dispose();
      skyDome = null;
      skyRenderer?.dispose();
      skyRenderer?.domElement.remove();
      skyRenderer = null;
    };
  }, [tools, autoPlay, ASSET, handControl, hand]);

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
          playRef.current = {
            flight: route === AUTO_TOUR ? AUTO_FLIGHT : buildFlight(route),
            i: 0,
            t: 0,
            phase: "fly",
          };
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
      {card && CARDS[card.stop % CARDS.length] && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end"
          style={{
            width: CARD_SCRIM_WIDTH,
            background:
              "linear-gradient(to left, rgb(0 0 0 / 0.86) 0%, rgb(0 0 0 / 0.74) 30%," +
              " rgb(0 0 0 / 0.45) 62%, rgb(0 0 0 / 0.16) 84%, transparent 100%)",
            opacity: interacting ? 0 : card.t,
            transition: "opacity 450ms ease",
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
              {KIND_LABEL[CARDS[card.stop % CARDS.length]!.kind] ??
                CARDS[card.stop % CARDS.length]!.kind}{" "}
              {String((card.stop % CARDS.length) + 1).padStart(2, "0")} /{" "}
              {String(CARDS.length).padStart(2, "0")}
            </div>
            <h2
              className="text-6xl font-bold leading-[1.04] tracking-tight"
              style={{ color: dark.text.primary }}
            >
              {CARDS[card.stop % CARDS.length]!.title}
            </h2>
            <p className="mt-6 max-w-[38rem] text-xl leading-snug" style={{ color: dark.text.secondary }}>
              {CARDS[card.stop % CARDS.length]!.blurb}
            </p>
          </div>
        </div>
      )}

      {/* Visualise the one globally owned hand while routed Explore is active. This is
          feedback, never a second tracker or a second gesture vocabulary. */}
      {handControl && handVisible && (
        <div className="pointer-events-none absolute right-8 top-8 flex flex-col items-end gap-2">
          <HandSkeleton
            source={hand}
            style={{
              width: 260,
              height: 195,
              borderRadius: 12,
              background: "rgb(0 0 0 / 0.45)",
              border: `1px solid ${dark.border}`,
              backdropFilter: "blur(6px)",
            }}
          />
          <div
            className="rounded-full px-4 py-1.5 text-xs font-semibold"
            style={{ background: "rgb(0 0 0 / 0.55)", color: dark.text.primary }}
          >
            EXPLORE · open hand left/right to turn · up/down to travel
          </div>
          {collisionBlocked && (
            <div
              className="rounded-full px-4 py-1.5 text-xs font-semibold"
              style={{ background: "rgb(0 0 0 / 0.62)", color: dark.text.primary }}
            >
              Boundary reached · move away to continue
            </div>
          )}
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
            <span
              style={{ color: fps >= fpsTarget - 3 ? dark.accent : dark.text.secondary }}
            >
              {fps} fps / {fpsTarget} target
            </span>
            {"  ·  Streamed SOG budget "}
            <span style={{ color: dark.accent }}>{(LOD_SPLAT_COUNT / 1e6).toFixed(1)}M</span>
            {` · dpr ${dpr.toFixed(2)}`}
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
        <span>?asset=web|mid|local|max · ?dpr=1|1.5|2 · ?budget=8000000</span>
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
