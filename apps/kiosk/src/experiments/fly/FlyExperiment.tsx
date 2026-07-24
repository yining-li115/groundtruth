import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { light } from "@groundtruth/tokens";
import { STOP_ACCENTS } from "./assetColors";
import { buildWorld, ANCHORS, N } from "./world";

/**
 * Fly-through experiment (/?exp=fly) — ONE persistent particle world (city + mapping
 * car + satellites + survey drone + data lines) and a camera that NAVIGATES it: each
 * scroll section flies to the next full-screen vantage point, like cuts in a video
 * story. The world itself is never rebuilt — only the camera moves.
 *
 * Alive without scroll: particle churn + twinkle and a gentle camera sway run on the
 * clock, so the frame is never frozen; scrolling only travels between stops (and can
 * play backwards).
 */

// One stop = 120vh of scroll (was 170 — the tour dragged); progress smoothing is snappier
// too, since Lenis already adds its own inertia on the real kiosk (double-smoothing at
// 0.09 read as "stuck").
export const SECTION_VH = 120;
export const HOLD = 0.45; // first 45% of a section = hold the vantage; the rest = fly on
export const SM_EASE = 0.16;

/** Scroll-runway height (vh) for `stops` camera stops: one section per transition PLUS
 *  0.4 of a section of tail room — the last card's title finishes revealing at
 *  p ≈ stops-1+0.32, so without the tail the finale gets stuck half-blurred. */
export const runwayVh = (stops: number) => (stops - 1 + 0.4) * SECTION_VH + 100;

interface Stop {
  pos: [number, number, number];
  target: [number, number, number];
}
const A = ANCHORS;
const STOPS: Stop[] = [
  { pos: [8.5, 5.0, 9.5], target: [0, 1.2, 0] }, // 0 overview — the whole world
  { pos: [2.4, 1.7, 3.4], target: [-0.4, 1.0, -0.6] }, // 1 into the city, rooftop level
  { pos: [-4.7, 0.8, 5.3], target: [A.car.x, A.car.y, A.car.z] }, // 2 street corner, the car
  { pos: [-0.1, 5.3, 1.0], target: [A.sat1.x, A.sat1.y, A.sat1.z] }, // 3 up at the satellite
  { pos: [3.7, 2.6, 3.3], target: [A.drone.x, A.drone.y, A.drone.z] }, // 4 beside the drone
  { pos: [11.5, 7.5, 12.5], target: [0, 1.4, 0] }, // 5 pull back — the world, small
];
const STOP_COUNT = STOPS.length;

export const CONTENT = [
  {
    tag: "TUM • Photogrammetry & Remote Sensing",
    title: "Making Machines See and Think in 3D",
    body: "Photogrammetry & Remote Sensing at TUM — turning pixels and points into an understanding of the world.",
    body2:
      "Every point below is a measurement: a laser return, a matched pixel, a satellite pass. Scroll to fly through the world they add up to.",
    meta: "Groundtruth • an interactive tour",
    link: "Start the tour ↓",
    pos: "left-1/2 top-[56vh] w-[54vw] -translate-x-1/2 text-center",
  },
  {
    tag: "Project • Digital Twin",
    title: "City-Scale Reconstruction",
    body: "From aerial imagery and dense LiDAR to a living digital twin: we reconstruct whole districts down to the last façade, and keep them up to date as the city changes.",
    body2:
      "The pipeline fuses oblique flights, mobile mapping and cadastral data into one semantic 3D model — streets, roofs, vegetation and all — accurate enough for planning, simulation and autonomous systems to build on.",
    meta: "Munich test site • 2,400 hectares • LoD2+",
    link: "Explore the project →",
    pos: "right-[6vw] top-[24vh] w-[40vw]",
  },
  {
    tag: "Research • LiDAR",
    title: "Multimodal Sensor Fusion",
    body: "Camera, LiDAR and radar see the world differently. Our mapping vehicle fuses them into one consistent picture of the street — robust enough for machines to trust.",
    body2:
      "On every drive the car cross-calibrates its sensors, tags what it sees, and feeds the lab with fresh training data: curbs, lanes, signs, pedestrians — the vocabulary of the road, labelled by the road itself.",
    meta: "Research platform • 6 sensors • 10 Hz fused",
    link: "About the platform →",
    pos: "left-[6vw] top-[28vh] w-[38vw]",
  },
  {
    tag: "Event • Remote Sensing",
    title: "Joint DLR–TUM Workshop",
    body: "Two days on spaceborne Earth observation: new sensors, new missions, and what season-by-season satellite time series reveal about our changing planet.",
    body2:
      "Talks range from SAR interferometry to hyperspectral imaging, with a hands-on session on our open time-series toolbox. Jointly organised with the German Aerospace Center (DLR).",
    meta: "TUM Garching • March 12–13, 2026",
    link: "Workshop programme →",
    pos: "right-[6vw] top-[34vh] w-[38vw]",
  },
  {
    tag: "Field • Survey",
    title: "Campus Photogrammetry Scan",
    body: "A drone flight over the TUM campus, four thousand images, one afternoon: the raw material for our teaching datasets and the campus digital twin.",
    body2:
      "Students plan the flight, calibrate the cameras, and turn the photos into a dense point cloud — the whole photogrammetric pipeline, end to end, on their own campus.",
    meta: "Campus • 4,000 images • GSD 1.5 cm",
    link: "See the scan →",
    pos: "left-[6vw] top-[26vh] w-[38vw]",
  },
  {
    tag: "Open • PhD • MCML",
    title: "Fully Funded PhD Positions",
    body: "From a billion scattered points to the next generation of ideas — join us and help machines make sense of the world in 3D.",
    body2:
      "We are hiring across photogrammetry, computer vision and machine learning, fully funded through MCML. Bring your own question — we provide the data, the compute, and the coffee.",
    meta: "3 positions • Apply by August 31",
    link: "Apply now →",
    pos: "left-1/2 top-[52vh] w-[54vw] -translate-x-1/2 text-center",
  },
];

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (t: number) => t * t * (3 - 2 * t);

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute vec3 aColor;
  attribute float aRand; attribute float aSize; attribute float aAlpha;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    // restless churn — the world simmers even when nobody scrolls
    vec3 p = position + vec3(
      sin(uTime * 0.9 + aRand * 43.0 + position.y * 1.7),
      cos(uTime * 0.7 + aRand * 71.0 + position.x * 1.4),
      sin(uTime * 0.8 + aRand * 57.0 + position.z * 1.9)
    ) * 0.04;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aSize * (320.0 / -mv.z);
    float twinkle = 0.78 + 0.22 * sin(uTime * (1.2 + aRand * 2.4) + aRand * 97.0);
    vAlpha = aAlpha * twinkle;
    vColor = aColor;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    float m = texture2D(uMap, gl_PointCoord).a;
    gl_FragColor = vec4(vColor, m * vAlpha);
  }
`;

function makeSprite(): THREE.Texture {
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

export function splitProgress(pRaw: number, stopCount = STOP_COUNT) {
  const p = Math.min(Math.max(pRaw, 0), stopCount - 1);
  const seg = Math.min(Math.floor(p), stopCount - 2);
  const frac = p - seg;
  const mt = clamp01((frac - HOLD) / (1 - HOLD));
  return { p, seg, frac, mt };
}

/** Shared card choreography: visibility window, drift, word reveal, body slide-in. */
export function updateCards(cards: (HTMLDivElement | null)[], p: number) {
  cards.forEach((el, i) => {
    if (!el) return;
    const d = p - (i + 0.22);
    const vis = 1 - Math.min(Math.max((Math.abs(d) - 0.32) / 0.14, 0), 1);
    el.style.opacity = String(vis);
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner) inner.style.transform = `translateY(${(-d * 30).toFixed(1)}px)`;
    if (vis > 0) {
      const rev = Math.min(Math.max((p - i + 0.18) / 0.5, 0), 1);
      // per-character blur-in, scrubbed (the classic hero's BlurScrollText feel):
      // a 6-char soft window sweeps across the title as `rev` advances
      const chars = el.querySelectorAll<HTMLElement>("[data-char]");
      const nc = chars.length;
      const W = 6;
      chars.forEach((c, ci) => {
        const v = Math.min(Math.max((rev * (nc + W) - ci) / W, 0), 1);
        c.style.opacity = (0.05 + 0.95 * v).toFixed(3);
        c.style.filter = v >= 1 ? "none" : `blur(${((1 - v) * 10).toFixed(1)}px)`;
      });
      const body = el.querySelector<HTMLElement>("[data-body]");
      if (body) {
        const on = rev > 0.5;
        body.style.opacity = on ? "1" : "0";
        body.style.transform = on ? "translateY(0)" : "translateY(10px)";
      }
    }
  });
}

function CameraRig({ smRef }: { smRef: { current: number } }) {
  const posA = useMemo(() => new THREE.Vector3(), []);
  const posB = useMemo(() => new THREE.Vector3(), []);
  const tgtA = useMemo(() => new THREE.Vector3(), []);
  const tgtB = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    const { seg, frac, mt } = splitProgress(smRef.current);
    const a = STOPS[seg]!;
    const b = STOPS[Math.min(seg + 1, STOP_COUNT - 1)]!;
    const e = smooth(smooth(mt)); // double-smooth = slow out of a stop, glide into the next
    posA.set(...a.pos);
    posB.set(...b.pos);
    tgtA.set(...a.target);
    tgtB.set(...b.target);
    const pos = posA.lerp(posB, e);
    const tgt = tgtA.lerp(tgtB, e);
    // during a hold, drift slightly closer with scroll (parallax you can feel & rewind)
    const dolly = seg === 0 && frac < HOLD ? 0 : 0.06;
    pos.lerp(tgt, Math.min(frac, HOLD) * dolly);
    // always-on sway — the shot breathes even with no scroll input
    const t = state.clock.elapsedTime;
    pos.x += Math.sin(t * 0.13) * 0.12;
    pos.y += Math.sin(t * 0.09 + 1.7) * 0.07;
    pos.z += Math.cos(t * 0.11) * 0.1;
    state.camera.position.copy(pos);
    state.camera.lookAt(tgt);
  });
  return null;
}

function WorldCloud() {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const sprite = useMemo(makeSprite, []);

  const geom = useMemo(() => {
    const w = buildWorld();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(w.positions, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(w.colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(w.sizes, 1));
    g.setAttribute("aRand", new THREE.BufferAttribute(w.rands, 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(w.alphas, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 30);
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSize: { value: 0.16 },
      uMap: { value: sprite },
    }),
    [sprite],
  );

  useFrame((state) => {
    const u = matRef.current?.uniforms;
    if (u) u.uTime!.value = state.clock.elapsedTime;
  });

  return (
    <points geometry={geom} frustumCulled={false}>
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={VERT}
        fragmentShader={FRAG}
        transparent
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
}

export function ContentCard({
  item,
  accent,
  refCb,
  big = false,
  staticCard = false,
}: {
  item: (typeof CONTENT)[number];
  accent: string;
  refCb: (el: HTMLDivElement | null) => void;
  /** hero-sized title (the home-page motto treatment) */
  big?: boolean;
  /** fully lit from the start — no word-by-word reveal, no body slide-in (the slogan
   *  must always read whole, exactly like the real home hero) */
  staticCard?: boolean;
}) {
  const centered = item.pos.includes("text-center");
  return (
    <div
      ref={refCb}
      className={`fixed z-10 ${item.pos}`}
      style={{ opacity: 0, willChange: "opacity", pointerEvents: "none" }}
    >
      <div>
        {item.tag && (
          <div className="mb-3 text-xs font-bold uppercase tracking-widest" style={{ color: accent }}>
            {item.tag}
          </div>
        )}
        <h2
          className={`font-bold tracking-tight ${
            big
              ? "text-7xl leading-[1.02] md:text-8xl" // exactly the classic hero motto
              : "text-4xl leading-[1.05] md:text-6xl"
          }`}
        >
          {/* "\n" in a title forces a line break (the homepage motto is two lines).
              Non-static titles reveal per CHARACTER with the classic hero's blur effect
              (BlurScrollText's values: blur 10px → 0, opacity ~0 → 1, staggered), driven
              frame-by-frame from scroll — scrubbed and reversible, no CSS transitions. */}
          {item.title.split("\n").map((line, li) => (
            <span key={li} className="block">
              {staticCard
                ? line
                : line.split(" ").map((w, wi) => (
                    <span key={wi}>
                      <span className="inline-block whitespace-nowrap">
                        {Array.from(w).map((ch, ci) => (
                          <span
                            key={ci}
                            data-char
                            className="inline-block"
                            style={{
                              opacity: 0.05,
                              filter: "blur(10px)",
                              willChange: "filter, opacity",
                            }}
                          >
                            {ch}
                          </span>
                        ))}
                      </span>{" "}
                    </span>
                  ))}
            </span>
          ))}
        </h2>
        <div
          {...(staticCard ? {} : { "data-body": true })}
          className="max-w-xl"
          style={{
            opacity: staticCard ? 1 : 0,
            transition: "opacity 0.4s linear, transform 0.4s ease-out",
            transform: staticCard ? undefined : "translateY(10px)",
            marginLeft: centered ? "auto" : undefined,
            marginRight: centered ? "auto" : undefined,
          }}
        >
          {item.body && (
            <p className="mt-5 text-base leading-relaxed md:text-lg" style={{ color: "var(--gt-text-secondary)" }}>
              {item.body}
            </p>
          )}
          {item.body2 && (
            <p className="mt-4 text-base leading-relaxed md:text-lg" style={{ color: "var(--gt-text-secondary)" }}>
              {item.body2}
            </p>
          )}
          <div
            className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm"
            style={{ justifyContent: centered ? "center" : undefined }}
          >
            {/* static (hero) card: the hint reads like the classic "Spotlight ↓" —
                primary black, larger; story cards keep the accent-coloured link */}
            <span
              className={`font-bold ${staticCard ? "text-xl" : ""}`}
              style={{ color: staticCard ? "var(--gt-text-primary)" : accent }}
            >
              {item.link}
            </span>
            {item.meta && <span style={{ color: "var(--gt-text-secondary)" }}>{item.meta}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FlyExperiment() {
  const smRef = useRef(0);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const sectionPx = window.innerHeight * (SECTION_VH / 100);
      const raw = window.scrollY / sectionPx;
      smRef.current += (raw - smRef.current) * SM_EASE;
      const p = smRef.current;

      updateCards(cardRefs.current, p);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  if (reduced) {
    return (
      <div
        className="min-h-screen px-[8vw] py-24"
        style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)" }}
      >
        {CONTENT.map((c, i) => (
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
      <div className="fixed inset-0">
        <Canvas
          camera={{ position: STOPS[0]!.pos, fov: 45 }}
          dpr={[1, 1.5]}
          gl={{ antialias: false, powerPreference: "high-performance" }}
        >
          <color attach="background" args={[light.bg]} />
          <CameraRig smRef={smRef} />
          <WorldCloud />
        </Canvas>
      </div>

      <header className="fixed left-8 top-6 z-10 text-xs font-bold leading-tight">
        <div>Professorship of Photogrammetry and Remote Sensing</div>
        <div style={{ color: "var(--gt-text-secondary)" }}>
          Fly-through experiment · {N.toLocaleString()} points
        </div>
      </header>

      {CONTENT.map((c, i) => (
        <ContentCard
          key={c.title}
          item={c}
          accent={STOP_ACCENTS[i]!}
          refCb={(el) => {
            cardRefs.current[i] = el;
          }}
        />
      ))}

      {/* one full section per stop */}
      <div style={{ height: `${runwayVh(STOP_COUNT)}vh` }} />
    </div>
  );
}
