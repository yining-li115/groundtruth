import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

/**
 * The sky behind the campus gaussians.
 *
 * The scan has no sky in it. A photogrammetric capture reconstructs the surfaces a camera
 * saw, and nobody photographs the air — so everything above the rooflines is not "dark", it
 * is *absent*, and it rendered as the clear colour: black. That was invisible for as long as
 * the flight only ever sat on the five composed stops, every one of which was verified to be
 * filled by the model (`scripts/build-tour.py`, fill ≥ 0.996). The moment a visitor's hand can
 * turn the camera, that guarantee is gone: one look up and the campus is standing in a void.
 *
 * WHY AN ANALYTIC SKY RATHER THAN A GENERATED IMAGE. A photo — generated or otherwise — is one
 * fixed sky at one fixed hour, wrapped on a sphere, with a seam to hide and no relationship to
 * anything. This is three.js's own `Sky`: the Preetham daylight model, the standard analytic
 * skydome, already in the `three` package we ship (no new dependency, CLAUDE.md §3). It gives
 * a real gradient, a real sun with real glow and real horizon haze — and, because it is
 * parametric, the light can *move*.
 *
 * So it does. The sun's elevation is computed from the wall's own clock and Munich's latitude,
 * so at nine in the morning the sky over the model is the sky outside the door, and it warms
 * and lowers through the afternoon exactly as the real one does. That costs nothing per frame
 * (the position is recomputed once a minute) and it is the difference between a backdrop and a
 * window.
 *
 * TWO CLAMPS, both deliberate:
 *
 *   - Elevation never drops below `MIN_ELEVATION_DEG`. The scan itself is daylit — flat, cool,
 *     soft-shadowed midday — and hanging a midnight sky behind a midday building does not read
 *     as "it is night", it reads as broken compositing. After sunset the sky holds at a low,
 *     warm late-afternoon instead, which is a small lie that looks like the truth.
 *   - `SCAN_NORTH_YAW_DEG` is NOT MEASURED. Compass azimuth is real; which way the scan's +Z
 *     points is not known, so the sun's *direction* is only as right as this offset, which was
 *     set by eye against the shadows in the model. Elevation — the part that actually drives
 *     the colour and the brightness — does not depend on it.
 *
 * ASSET COLOURS. Everything below is a property of a rendered scene, not of the interface, so
 * it is exempt from the token palette by the design-system's "asset colors" exception
 * (`docs/design-system.md` §2) and lives here, next to the scene, rather than in
 * `packages/tokens`. Nothing here may be reused for UI.
 *
 * Every knob is overridable from the URL, because sky is judged by looking at it on the actual
 * panel and a redeploy per tweak is not a tuning loop:
 *   ?sky=0            turn it off entirely (back to the black void, for comparison)
 *   ?skyhour=17.5     freeze the clock at this local hour instead of tracking the real one
 *   ?skyel=  ?skyaz=  force elevation / azimuth in degrees, ignoring the sun entirely
 *   ?skynorth=        the scan's north offset, the one unmeasured number above
 *   ?skyturb= ?skyray= ?skymie= ?skyg=       haze, blue, glow strength, glow tightness
 *   ?skyexp=          overall brightness, if it fights the model's exposure
 */

// --- asset parameters (NOT design tokens — see the note above) --------------------------

/** Where the wall is. Used only to put the sun in the right place at the right hour. */
const MUNICH = { lat: 48.1486, lon: 11.568 };

/**
 * How far the scan's +Z axis is rotated from true north, in degrees.
 *
 * UNMEASURED. Set by eye so the sun sits on the side the model's shadows fall away from. The
 * scan's upright yaw (20.9°) fixes which way is *up*, not which way is north. If the real
 * bearing is ever recovered, put it here.
 */
const SCAN_NORTH_YAW_DEG = 200;

/** Never let the sun set. See the note above on why a night sky behind a daylit scan is worse
 *  than a slightly dishonest one. */
const MIN_ELEVATION_DEG = 9;
/** ...and never let it get high and harsh enough to wash the model out. */
const MAX_ELEVATION_DEG = 62;

/**
 * Preetham's four. Tuned toward the scan itself, which was captured on a bright but hazy day:
 * soft shadows, a cool desaturated cast, no deep blue overhead. A clean 2.0/1.0 sky (three's
 * own defaults) reads as a much sharper day than the buildings underneath it are having.
 */
const TURBIDITY = 5.5; // haze. higher = whiter, softer, more European
const RAYLEIGH = 1.6; // how blue the blue is
const MIE_COEFFICIENT = 0.006; // strength of the glow around the sun
const MIE_DIRECTIONAL_G = 0.78; // how tight that glow is
/** Overall brightness. The model is rendered without tone mapping, so the sky has to meet it. */
const EXPOSURE = 0.85;

/**
 * How big the dome is, in world units (1 unit ≈ 3 m).
 *
 * It only has to enclose everything and stay inside the camera's far plane (2000). The campus
 * crop is ~60 units across and a visitor may get 12 units from the tour's pose, so 900 has
 * enormous margin at both ends. `depthWrite` is off in Sky's own material, so its distance
 * never fights the splats for depth.
 */
const DOME_SCALE = 900;

/** How often the sun is repositioned. It moves 0.25° a minute; nobody has ever seen that. */
const RESUN_MS = 60_000;

// --- URL knobs ---------------------------------------------------------------------------

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const raw = PARAMS?.get(key);
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};
const opt = (key: string): number | null => {
  const raw = PARAMS?.get(key);
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};

/** `?sky=0` puts the black void back, for judging whether the sky is an improvement. */
export const SKY_ENABLED = PARAMS?.get("sky") !== "0";

// --- the sun ------------------------------------------------------------------------------

/** Where the sun is over Munich, in degrees: elevation above the horizon, compass azimuth. */
export function sunAngles(date: Date, hourOverride: number | null = null): {
  elevation: number;
  azimuth: number;
} {
  // NOAA's solar position, in the form the calculator publishes it. Accurate to a fraction of
  // a degree, which is far past what anyone can see in a gradient.
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  const localHours =
    hourOverride ?? date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  // getTimezoneOffset is minutes WEST of UTC; the formula wants hours east.
  const tzHours = -date.getTimezoneOffset() / 60;

  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (localHours - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);

  const timeOffset = eqTime + 4 * MUNICH.lon - 60 * tzHours; // minutes
  const trueSolarMin = localHours * 60 + timeOffset;
  const hourAngle = THREE.MathUtils.degToRad(trueSolarMin / 4 - 180);

  const lat = THREE.MathUtils.degToRad(MUNICH.lat);
  const cosZenith = THREE.MathUtils.clamp(
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle),
    -1,
    1,
  );
  const zenith = Math.acos(cosZenith);
  const sinZenith = Math.sin(zenith);

  let azimuth: number;
  if (sinZenith < 1e-6) {
    azimuth = 180;
  } else {
    const cosAz = THREE.MathUtils.clamp(
      (Math.sin(lat) * cosZenith - Math.sin(decl)) / (Math.cos(lat) * sinZenith),
      -1,
      1,
    );
    // The published form measures from SOUTH; the +180 puts it on the compass, from north.
    azimuth = THREE.MathUtils.radToDeg(Math.acos(cosAz));
    if (hourAngle > 0) azimuth = 360 - azimuth;
  }

  return { elevation: 90 - THREE.MathUtils.radToDeg(zenith), azimuth };
}

// --- the dome -----------------------------------------------------------------------------

export interface SkyDome {
  /** add this to the scene */
  readonly object: THREE.Object3D;
  /** re-place the sun if enough time has passed. Safe to call every frame. */
  update(nowMs: number): void;
  /** the angles currently in force, for the HUD */
  readonly current: { elevation: number; azimuth: number };
  dispose(): void;
}

export function createSkyDome(): SkyDome {
  const sky = new Sky();
  sky.scale.setScalar(DOME_SCALE);
  // It is scenery, not geometry: never let it occlude a splat, and draw it first.
  sky.renderOrder = -1;
  sky.frustumCulled = false;

  // Named rather than indexed, and it throws: if a three upgrade ever renames one of
  // Preetham's uniforms, the sky must fail loudly here rather than silently render the
  // default weather forever.
  const uniform = (name: string): THREE.IUniform => {
    const entry = sky.material.uniforms[name];
    if (!entry) throw new Error(`three's Sky has no "${name}" uniform (version mismatch?)`);
    return entry;
  };
  uniform("turbidity").value = num("skyturb", TURBIDITY);
  uniform("rayleigh").value = num("skyray", RAYLEIGH);
  uniform("mieCoefficient").value = num("skymie", MIE_COEFFICIENT);
  uniform("mieDirectionalG").value = num("skyg", MIE_DIRECTIONAL_G);
  const sunUniform = uniform("sunPosition");
  sky.material.transparent = false;

  const exposure = num("skyexp", EXPOSURE);
  // Preetham's output is scaled for a tone-mapped renderer; ours has none (turning tone
  // mapping on globally would change how the SPLATS read, which is the one thing this must
  // not do). A plain multiply on the way out is enough, and it keeps the model untouched.
  sky.material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "gl_FragColor = vec4( retColor, 1.0 );",
      `gl_FragColor = vec4( retColor * ${exposure.toFixed(4)}, 1.0 );`,
    );
  };

  const northYaw = num("skynorth", SCAN_NORTH_YAW_DEG);
  const forcedEl = opt("skyel");
  const forcedAz = opt("skyaz");
  const forcedHour = opt("skyhour");

  const sun = new THREE.Vector3();
  const current = { elevation: 0, azimuth: 0 };
  let nextSunAt = -Infinity;

  const place = (): void => {
    const solar = sunAngles(new Date(), forcedHour);
    const elevation =
      forcedEl ??
      THREE.MathUtils.clamp(solar.elevation, MIN_ELEVATION_DEG, MAX_ELEVATION_DEG);
    const azimuth = forcedAz ?? solar.azimuth;
    current.elevation = elevation;
    current.azimuth = azimuth;
    // phi from the zenith, theta measured from the model's +Z — hence the north offset.
    sun.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - elevation),
      THREE.MathUtils.degToRad(azimuth + northYaw),
    );
    (sunUniform.value as THREE.Vector3).copy(sun);
  };
  place();

  return {
    object: sky,
    current,
    update(nowMs: number): void {
      if (nowMs < nextSunAt) return;
      nextSunAt = nowMs + RESUN_MS;
      place();
    },
    dispose(): void {
      sky.geometry.dispose();
      sky.material.dispose();
    },
  };
}
