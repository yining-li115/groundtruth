import { useEffect, useRef, useState } from "react";
// @ts-expect-error — @mkkellogg/gaussian-splats-3d ships no type declarations
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import * as THREE from "three";
import { light } from "@groundtruth/tokens";
import { INK, STOP_ACCENTS } from "./assetColors";
import {
  CONTENT,
  ContentCard,
  runwayVh,
  SECTION_VH,
  SM_EASE,
  smooth,
  splitProgress,
  updateCards,
} from "./FlyExperiment";

/**
 * Splat fly-through (/?exp=flysplat) — the fly-through story, but the world is the REAL
 * TUM campus gaussians instead of the procedural particle city. Scroll navigates a
 * continuous orbit around the campus: each stop is an (azimuth, radius, height, aim)
 * framing; between stops the camera glides on, so the whole page reads as one long
 * drone shot with editorial pauses. Camera sway runs on the clock — alive without
 * scroll input.
 *
 * Same content cards / choreography as FlyExperiment (imported from it).
 */

const PLY_URL = "/splat/tum-campus-web.ply";
const CAMERA_UP: [number, number, number] = [0, -1, 0]; // the scan is inverted
const T = { x: -1.5, y: -1, z: -4.5 }; // campus centre (from the showreel framing)

interface Stop {
  theta: number; // azimuth around the campus (radians) — monotonic = one continuous orbit
  r: number; // horizontal orbit radius
  h: number; // camera height above the target (along -Y)
  aim: [number, number, number]; // target offset from the campus centre
  shift: number; // screen-pan along camera-right: >0 pushes the campus RIGHT, <0 LEFT
}
// `shift` parks the campus OPPOSITE each stop's content card (card right → campus left…);
// centred cards sit low, so those stops raise the aim (y is DOWN in this scan) instead.
const STOPS: Stop[] = [
  // 0 opening = the HOME HERO composition: campus LARGE, just right of centre, raised;
  // motto bottom-left (aligned with the classic hero's overlay)
  { theta: -0.446, r: 66, h: 32, aim: [0, 8, 0], shift: 10 },
  { theta: 0.4, r: 68, h: 24, aim: [8, 4, 2], shift: -30 }, // 1 buildings left, card right
  { theta: 1.4, r: 50, h: 13, aim: [-4, 7, 6], shift: 26 }, // 2 street level right, card left
  { theta: 2.5, r: 88, h: 62, aim: [0, 7, 0], shift: -38 }, // 3 high look-down left, card right, raised
  { theta: 3.55, r: 58, h: 20, aim: [7, 5, -5], shift: 28 }, // 4 finale — Campus Photogrammetry Scan
];
export const STOP_COUNT = STOPS.length;
// the tour ends on the campus-scan story — one card per stop; the opening card IS the
// homepage motto: two forced lines, bottom-left, no tag/body — just the scroll hint
export const PAGES = [
  {
    ...CONTENT[0]!,
    title: "Making Machines\nSee and Think in 3D",
    tag: "",
    body: "",
    body2: "",
    meta: "",
    link: "Scroll to explore ↓",
    // anchored like the classic hero overlay: 2.5rem from the left AND from the bottom,
    // so the motto block lines up with Home A regardless of window height
    pos: "left-10 bottom-10 w-[72vw]",
  },
  ...CONTENT.slice(1, STOP_COUNT),
];

const posFor = (s: { theta: number; r: number; h: number }, aim: THREE.Vector3) =>
  new THREE.Vector3(
    aim.x + s.r * Math.cos(s.theta),
    aim.y - s.h,
    aim.z + s.r * Math.sin(s.theta),
  );

// Abstract-ink mode (default; ?exp=flysplat&ink=0 restores the photographic campus):
// string-patch the splat vertex shader to override every splat's colour with a
// near-black ink, and flip the library's POINT-CLOUD mode on — that forces both
// screen-space eigenvalues to a constant, so every gaussian renders as an identical
// round dot (true particles; no more anisotropic ellipse footprints). In dot mode
// `splatScale` is the dot radius: &scale=3 for chunkier grain, &scale=1 for fine dust.
const PARAMS =
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
const INK_MODE = PARAMS?.get("ink") !== "0";
const INK_SPLAT_SCALE = Number(PARAMS?.get("scale")) || 2.0;
const INK_KEEP = Number(PARAMS?.get("keep")) || 0.5; // fraction of splats kept (&keep=0.3 = sparser)
const INK_ALPHA = 0.82; // thins the accumulated ink so overlaps stay airy

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchInk(mesh: any, ink: THREE.Color): boolean {
  const mat: THREE.ShaderMaterial | undefined = mesh?.material;
  if (!mat || typeof mat.vertexShader !== "string") return false;
  if (mat.uniforms?.uInk) return true; // already patched
  const DECL = "attribute uint splatIndex;";
  const COLOR = "vColor = uintToRGBAVec(sampledCenterColor.r);";
  if (!mat.vertexShader.includes(COLOR)) return false;
  mat.vertexShader = mat.vertexShader
    .replace(DECL, `${DECL}\nuniform vec3 uInk;\nuniform float uInkAlpha;\nuniform float uInkKeep;`)
    .replace(
      COLOR,
      `${COLOR}
  vColor.rgb = uInk * (0.6 + 0.8 * fract(float(splatIndex) * 0.1031));
  vColor.a *= uInkAlpha;
  // sparse dust: randomly drop a fraction of the splats entirely
  if (fract(float(splatIndex) * 0.7519) > uInkKeep) vColor.a = 0.0;`,
    );
  mat.uniforms.uInk = { value: ink };
  mat.uniforms.uInkAlpha = { value: INK_ALPHA };
  mat.uniforms.uInkKeep = { value: INK_KEEP };
  // true particle rendering: identical round dots, sized by splatScale
  if (mat.uniforms.pointCloudModeEnabled) mat.uniforms.pointCloudModeEnabled.value = 1;
  if (mat.uniforms.splatScale) mat.uniforms.splatScale.value = INK_SPLAT_SCALE;
  mat.needsUpdate = true;
  return true;
}

/**
 * The whole splat stage as a reusable hook — viewer + ink-dot patch + scroll-smoothed
 * progress + camera navigation + card choreography — so the REAL home scene (HomeFly)
 * and this experiment page share one implementation. `active: false` skips setup
 * (reduced motion).
 */
export function useFlySplatStage(
  stageRef: { current: HTMLDivElement | null },
  smRef: { current: number },
  cardRefs: { current: (HTMLDivElement | null)[] },
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const el = stageRef.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;

    // opaque canvas cleared to the page bg — same reasoning as the home HeroSplat
    // (a transparent canvas premultiplies and washes the gaussians out)
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      precision: "highp",
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(new THREE.Color(light.bg), 1);
    renderer.setSize(el.offsetWidth || 1, el.offsetHeight || 1);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    el.appendChild(renderer.domElement);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewer: any = new GaussianSplats3D.Viewer({
      rootElement: el,
      renderer,
      sharedMemoryForWorkers: false,
      useBuiltInControls: false,
      cameraUp: CAMERA_UP,
      initialCameraPosition: posFor(STOPS[0]!, new THREE.Vector3(T.x, T.y, T.z)).toArray(),
      initialCameraLookAt: [T.x, T.y, T.z],
    });

    const resize = new ResizeObserver(() => {
      const w = el.offsetWidth || 1;
      const h = el.offsetHeight || 1;
      renderer.setSize(w, h);
      const cam = viewer.camera;
      if (cam) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      viewer.forceRenderNextFrame?.();
    });
    resize.observe(el);

    const aimA = new THREE.Vector3();
    const aimB = new THREE.Vector3();

    viewer
      .addSplatScene(PLY_URL, {
        // ink mode drops faint splats at load — sparser AND cheaper to sort/draw
        splatAlphaRemovalThreshold: INK_MODE ? 30 : 5,
        showLoadingUI: false,
      })
      .then(() => {
        if (disposed) return;
        viewer.start();
        const start = performance.now();
        let inked = !INK_MODE;

        const tick = (now: number) => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);
          // the splat mesh builds async — keep trying until the ink patch lands
          if (!inked) inked = patchInk(viewer.getSplatMesh?.(), INK);

          // scroll → progress (smoothed), shared by camera + cards
          const sectionPx = window.innerHeight * (SECTION_VH / 100);
          const raw = window.scrollY / sectionPx;
          smRef.current += (raw - smRef.current) * SM_EASE;
          updateCards(cardRefs.current, smRef.current);

          const cam = viewer.camera;
          if (!cam) return;
          const { seg, mt } = splitProgress(smRef.current, STOP_COUNT);
          const a = STOPS[seg]!;
          const b = STOPS[Math.min(seg + 1, STOP_COUNT - 1)]!;
          // single smoothstep — a double ramp made the mid-flight rotation whip
          const e = smooth(mt);

          aimA.set(T.x + a.aim[0], T.y + a.aim[1], T.z + a.aim[2]);
          aimB.set(T.x + b.aim[0], T.y + b.aim[1], T.z + b.aim[2]);
          const aim = aimA.lerp(aimB, e);
          // interpolate the ORBIT parameters (not raw positions) — the camera flies an
          // arc around the campus instead of cutting through it
          const theta = a.theta + (b.theta - a.theta) * e;
          const r = a.r + (b.r - a.r) * e;
          const h = a.h + (b.h - a.h) * e;
          const shift = a.shift + (b.shift - a.shift) * e;

          const t = (now - start) / 1000;
          const px = aim.x + r * Math.cos(theta) + Math.sin(t * 0.09) * 1.1;
          const py = aim.y - h + Math.sin(t * 0.06 + 1.7) * 0.6;
          const pz = aim.z + r * Math.sin(theta) + Math.cos(t * 0.08) * 0.9;
          cam.position.set(px, py, pz);
          cam.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2]);
          // pan the LOOK target along camera-right so the campus parks beside its card
          const fx = aim.x - px;
          const fz = aim.z - pz;
          const rl = Math.hypot(fx, fz) || 1;
          cam.lookAt(aim.x - (fz / rl) * shift, aim.y, aim.z - (-fx / rl) * shift);
          viewer.forceRenderNextFrame?.();
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => console.error("[flysplat] load failed", e));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      try {
        viewer?.dispose?.();
      } catch {
        /* not fully initialised on fast unmount */
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
    // stageRef/smRef/cardRefs are stable ref objects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

export function FlySplatExperiment() {
  const smRef = useRef(0);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useFlySplatStage(stageRef, smRef, cardRefs, !reduced);

  if (reduced) {
    return (
      <div
        className="min-h-screen px-[8vw] py-24"
        style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}
      >
        {PAGES.map((c, i) => (
          <article key={c.title} className="mb-24 max-w-3xl">
            <div
              className="mb-3 text-xs font-bold uppercase tracking-widest"
              style={{ color: STOP_ACCENTS[i] }}
            >
              {c.tag}
            </div>
            <h2 className="text-5xl font-bold tracking-tight">{c.title}</h2>
            <p className="mt-5 text-lg" style={{ color: "var(--gt-text-secondary)" }}>
              {c.body}
            </p>
            <p className="mt-4 text-lg" style={{ color: "var(--gt-text-secondary)" }}>
              {c.body2}
            </p>
            <p className="mt-4 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
              {c.meta}
            </p>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}>
      <div ref={stageRef} className="fixed inset-0" />

      <header className="fixed left-8 top-6 z-10 text-xs font-bold leading-tight">
        <div>Professorship of Photogrammetry and Remote Sensing</div>
        <div style={{ color: "var(--gt-text-secondary)" }}>
          Campus fly-through · {INK_MODE ? "abstract ink" : "photographic"} gaussians
        </div>
      </header>

      {PAGES.map((c, i) => (
        <ContentCard
          key={c.title}
          item={c}
          accent={STOP_ACCENTS[i]!}
          big={i === 0}
          refCb={(el) => {
            cardRefs.current[i] = el;
          }}
        />
      ))}

      <div style={{ height: `${runwayVh(STOP_COUNT)}vh` }} />
    </div>
  );
}
