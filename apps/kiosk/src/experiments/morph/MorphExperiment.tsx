import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { light } from "@groundtruth/tokens";
import { SHAPE_PALETTES, DUST_JITTER } from "./assetColors";
import { buildShapes, N, SHAPE_COUNT } from "./shapes";

/**
 * Scroll-morph experiment (/?exp=morph) — the reference video's TECHNIQUE (one WebGL
 * particle cloud re-forming per scroll section), in OUR design language.
 *
 * What sells the life-like feel (all GPU, three uniforms per frame):
 * - POUR, not lerp: each particle flies a bezier arc that peaks ABOVE its landing spot,
 *   so transitions read as dust streaming down and stacking into the next object;
 *   low points settle first (height-staggered timing).
 * - Restless at rest: multi-phase sine churn + per-particle alpha twinkle — the shape
 *   is never frozen, it simmers.
 * - Camera cuts: every shape has its own framing (azimuth/elevation/distance/aim); the
 *   camera drifts slowly with scroll during a hold and swings to the next framing
 *   during the morph.
 * - Animated pose: the figures shape carries TWO sampled poses (arms apart / hands
 *   met) with per-particle correspondence — while held, the cloud claps on a loop.
 */

const SECTION_VH = 170; // scroll length of one shape section (hold + morph)
const HOLD = 0.45; // first 45% of a section = shape holds; rest = morph to next
const SM_EASE = 0.09; // scroll smoothing

// One "page" of content per shape — the home page's fake news (NewsGrid ITEMS /
// content/showreel.json), matched to the shape it suits. `pos` places the card: the
// cards wander around the frame (upper-right, lower-left, …) so shape + text stagger
// and slightly overlap instead of stacking in the middle.
const CONTENT = [
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
    pos: "left-[6vw] top-[30vh] w-[38vw]",
  },
  {
    tag: "Event • Remote Sensing",
    title: "Joint DLR–TUM Workshop",
    body: "Two days on spaceborne Earth observation: new sensors, new missions, and what season-by-season satellite time series reveal about our changing planet.",
    body2:
      "Talks range from SAR interferometry to hyperspectral imaging, with a hands-on session on our open time-series toolbox. Jointly organised with the German Aerospace Center (DLR).",
    meta: "TUM Garching • March 12–13, 2026",
    link: "Workshop programme →",
    pos: "right-[6vw] top-[38vh] w-[38vw]",
  },
  {
    tag: "Award • Reconstruction",
    title: "Best Paper Award at ISPRS 2026",
    body: "Our work on regularised mesh reconstruction from fused aerial LiDAR and imagery received the conference best paper award.",
    body2:
      "The jury highlighted the method's clean geometry on complex roofscapes — and the open benchmark we released with it, already picked up by groups on three continents.",
    meta: "ISPRS Congress 2026 • Toronto",
    link: "Read the paper →",
    pos: "left-[6vw] top-[22vh] w-[38vw]",
  },
  {
    tag: "Open • PhD • MCML",
    title: "Fully Funded PhD Positions",
    body: "From a billion scattered points to the next generation of ideas — join us and help machines make sense of the world in 3D.",
    body2:
      "We are hiring across photogrammetry, computer vision and machine learning, fully funded through MCML. Bring your own question — we provide the data, the compute, and the coffee.",
    meta: "3 positions • Apply by August 31",
    link: "Apply now →",
    pos: "left-1/2 top-[50vh] w-[54vw] -translate-x-1/2 text-center",
  },
];

// Per-shape camera framing: azimuth θ, elevation φ, distance, aim (tx,ty), and a slow
// scroll-tied azimuth drift while the shape is held. tx > 0 aims right of the model
// (model sits LEFT on screen); tx < 0 puts the model RIGHT; 0 centres it. Magnitudes
// are kept moderate so the model's edge reaches BEHIND the text card (slight overlap).
const CAMS = [
  // Close camera = the model FILLS its half of the frame (its edge slides behind the
  // text card); ty > 0 aims above the model → model sits a touch lower, and vice versa.
  { theta: 0.55, phi: 0.3, dist: 7.6, tx: 1.05, ty: 0.1, drift: 0.3 }, // city — left half, card right
  { theta: -0.75, phi: 0.13, dist: 6.4, tx: -1.0, ty: 0.0, drift: -0.28 }, // car — right half, card left
  { theta: 0.35, phi: -0.1, dist: 7.2, tx: 1.0, ty: -0.2, drift: 0.26 }, // satellite — left half, high
  { theta: 0.08, phi: 0.06, dist: 7.0, tx: -1.05, ty: 0.1, drift: -0.22 }, // people — right half, card left
  { theta: 0.0, phi: 0.22, dist: 9.0, tx: 0.0, ty: -0.2, drift: 0.18 }, // dust — full-bleed centre
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number) => t * t * (3 - 2 * t);

const VERT = /* glsl */ `
  uniform float uSeg;   // which transition pair (0..SHAPES-2)
  uniform float uT;     // morph progress within the pair, 0..1
  uniform float uClap;  // figures pose blend (0 = arms apart, 1 = hands met)
  uniform float uTime;
  uniform float uSize;
  // per-shape palettes: A = the shape we're leaving, B = the one we're building.
  // Colour runs bottom→top of the model (a→b) with per-particle jitter; uJit* = how
  // random vs. height-graded the mix is (the dust finale goes nearly full random).
  uniform vec3 uColA1; uniform vec3 uColA2; uniform vec3 uColB1; uniform vec3 uColB2;
  uniform float uJitA; uniform float uJitB;
  attribute vec3 aS1; attribute vec3 aS2; attribute vec3 aS3;
  attribute vec3 aS4; attribute vec3 aS5;
  attribute float aRand; attribute float aSize; attribute float aBokeh;
  varying float vAlpha;
  varying vec3 vColor;

  vec3 pick(float s) {
    if (s < 0.5) return position;                // city
    if (s < 1.5) return aS1;                     // car
    if (s < 2.5) return aS2;                     // satellite
    if (s < 3.5) return mix(aS3, aS4, uClap);    // figures — clap on a loop
    return aS5;                                  // dust
  }

  void main() {
    vec3 from = pick(uSeg);
    vec3 to = pick(uSeg + 1.0);

    // pour timing: per-particle jitter + LOW landing spots settle first (sand stacking)
    float hN = clamp((to.y + 2.2) / 4.4, 0.0, 1.0);
    float dly = aRand * 0.35 + hN * 0.3;
    float t = clamp((uT - dly * 0.62) / 0.38, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);

    // pour path: lift off the old shape, arc to a point ABOVE the landing spot, fall in
    vec3 r2 = fract(vec3(aRand * 711.3, aRand * 337.7, aRand * 523.9));
    vec3 ctrl = to + vec3((r2.x - 0.5) * 3.6, 2.6 + r2.y * 2.8, (r2.z - 0.5) * 2.4);
    float omt = 1.0 - t;
    vec3 p = omt * omt * from + 2.0 * omt * t * ctrl + t * t * to;

    // restless churn — the dust never sits still; ballooned further while in flight
    float bell = 4.0 * t * omt;
    float amp = 0.05 + bell * (0.35 + 0.7 * aRand);
    p += vec3(
      sin(uTime * 0.9 + aRand * 43.0 + p.y * 1.7),
      cos(uTime * 0.7 + aRand * 71.0 + p.x * 1.4),
      sin(uTime * 0.8 + aRand * 57.0 + p.z * 1.9)
    ) * amp;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aSize * (320.0 / -mv.z);
    // bokeh particles are big + faint (fake depth-of-field); everyone twinkles slightly
    float base = mix(0.7, 0.09, aBokeh);
    float twinkle = 0.78 + 0.22 * sin(uTime * (1.2 + aRand * 2.4) + aRand * 97.0);
    vAlpha = base * twinkle * (1.0 - 0.3 * bell);

    // colour: height-graded a→b per shape, jittered per particle, cross-faded with t
    float hF = clamp((from.y + 2.2) / 4.4, 0.0, 1.0);
    float rr = fract(aRand * 5.31);
    float mF = clamp(mix(hF, rr, uJitA) + (r2.x - 0.5) * 0.25, 0.0, 1.0);
    float mT = clamp(mix(hN, rr, uJitB) + (r2.x - 0.5) * 0.25, 0.0, 1.0);
    vColor = mix(mix(uColA1, uColA2, mF), mix(uColB1, uColB2, mT), t);
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

/** Maps smoothed scroll progress → (segment, frac, morph-t). */
function splitProgress(pRaw: number) {
  const p = Math.min(Math.max(pRaw, 0), SHAPE_COUNT - 1);
  const seg = Math.min(Math.floor(p), SHAPE_COUNT - 2);
  const frac = p - seg;
  const mt = clamp01((frac - HOLD) / (1 - HOLD));
  return { p, seg, frac, mt };
}

function CameraRig({ smRef }: { smRef: { current: number } }) {
  useFrame((state) => {
    const { seg, frac, mt } = splitProgress(smRef.current);
    const a = CAMS[seg]!;
    const b = CAMS[Math.min(seg + 1, SHAPE_COUNT - 1)]!;
    const e = smooth(mt);
    const mix = (x: number, y: number) => x + (y - x) * e;
    // the held shape's camera keeps drifting with scroll; the morph swings to the next
    const theta =
      mix(a.theta + a.drift * frac, b.theta) +
      Math.sin(state.clock.elapsedTime * 0.1) * 0.02;
    const phi = mix(a.phi, b.phi);
    const dist = mix(a.dist, b.dist);
    const tx = mix(a.tx, b.tx);
    const ty = mix(a.ty, b.ty);
    state.camera.position.set(
      tx + dist * Math.cos(phi) * Math.sin(theta),
      ty + dist * Math.sin(phi),
      dist * Math.cos(phi) * Math.cos(theta),
    );
    state.camera.lookAt(tx, ty, 0);
  });
  return null;
}

function MorphCloud({ smRef }: { smRef: { current: number } }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const sprite = useMemo(makeSprite, []);

  const geom = useMemo(() => {
    const [city, car, sat, peopleA, peopleB, dust] = buildShapes();
    const rand = new Float32Array(N);
    const size = new Float32Array(N);
    const bokeh = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      rand[i] = Math.random();
      const isBokeh = Math.random() < 0.05 ? 1 : 0;
      bokeh[i] = isBokeh;
      size[i] = isBokeh ? 3.5 + Math.random() * 3 : 0.4 + Math.random() * Math.random() * 1.6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(city!, 3));
    g.setAttribute("aS1", new THREE.BufferAttribute(car!, 3));
    g.setAttribute("aS2", new THREE.BufferAttribute(sat!, 3));
    g.setAttribute("aS3", new THREE.BufferAttribute(peopleA!, 3));
    g.setAttribute("aS4", new THREE.BufferAttribute(peopleB!, 3));
    g.setAttribute("aS5", new THREE.BufferAttribute(dust!, 3));
    g.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aBokeh", new THREE.BufferAttribute(bokeh, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({
      uSeg: { value: 0 },
      uT: { value: 0 },
      uClap: { value: 0 },
      uTime: { value: 0 },
      uSize: { value: 0.16 },
      uMap: { value: sprite },
      uColA1: { value: new THREE.Color() },
      uColA2: { value: new THREE.Color() },
      uColB1: { value: new THREE.Color() },
      uColB2: { value: new THREE.Color() },
      uJitA: { value: 0.25 },
      uJitB: { value: 0.25 },
    }),
    [sprite],
  );

  useFrame((state) => {
    const u = matRef.current?.uniforms;
    if (!u) return;
    const { seg, mt } = splitProgress(smRef.current);
    u.uSeg!.value = seg;
    u.uT!.value = mt;
    u.uTime!.value = state.clock.elapsedTime;
    // clap loop (~1.5s): wind up slowly, snap together, spring back
    const raw = 0.5 - 0.5 * Math.cos(state.clock.elapsedTime * 4.2);
    u.uClap!.value = smooth(raw);
    // palette pair for this transition (dust = last palette, near-random jitter)
    const nxt = Math.min(seg + 1, SHAPE_COUNT - 1);
    const pA = SHAPE_PALETTES[seg]!;
    const pB = SHAPE_PALETTES[nxt]!;
    (u.uColA1!.value as THREE.Color).copy(pA.a);
    (u.uColA2!.value as THREE.Color).copy(pA.b);
    (u.uColB1!.value as THREE.Color).copy(pB.a);
    (u.uColB2!.value as THREE.Color).copy(pB.b);
    u.uJitA!.value = seg === SHAPE_COUNT - 1 ? DUST_JITTER : 0.25;
    u.uJitB!.value = nxt === SHAPE_COUNT - 1 ? DUST_JITTER : 0.25;
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

function ContentCard({
  item,
  accent,
  refCb,
}: {
  item: (typeof CONTENT)[number];
  /** the shape's asset accent — ties the card to its particle palette */
  accent: string;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={refCb}
      className={`fixed z-10 ${item.pos}`}
      style={{ opacity: 0, willChange: "opacity", pointerEvents: "none" }}
    >
      {/* single inner wrapper: the scroll drift transform lands here, so it never
          fights the container's Tailwind centering transforms */}
      <div>
        <div
          className="mb-3 text-xs font-bold uppercase tracking-widest"
          style={{ color: accent }}
        >
          {item.tag}
        </div>
        <h2 className="text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
          {item.title.split(" ").map((w, i) => (
            // the space must live OUTSIDE the inline-block span — inside, it collapses
            // and the words fuse together
            <span key={i}>
              <span
                data-word
                className="inline-block"
                style={{ opacity: 0.14, transition: "opacity 0.25s linear" }}
              >
                {w}
              </span>{" "}
            </span>
          ))}
        </h2>
        <div
          data-body
          className="max-w-xl"
          style={{
            opacity: 0,
            transition: "opacity 0.4s linear, transform 0.4s ease-out",
            transform: "translateY(10px)",
            marginLeft: item.pos.includes("text-center") ? "auto" : undefined,
            marginRight: item.pos.includes("text-center") ? "auto" : undefined,
          }}
        >
          <p
            className="mt-5 text-base leading-relaxed md:text-lg"
            style={{ color: "var(--gt-text-secondary)" }}
          >
            {item.body}
          </p>
          <p
            className="mt-4 text-base leading-relaxed md:text-lg"
            style={{ color: "var(--gt-text-secondary)" }}
          >
            {item.body2}
          </p>
          <div className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm"
            style={{ justifyContent: item.pos.includes("text-center") ? "center" : undefined }}
          >
            <span className="font-bold" style={{ color: accent }}>
              {item.link}
            </span>
            <span style={{ color: "var(--gt-text-secondary)" }}>{item.meta}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MorphExperiment() {
  const smRef = useRef(0);
  const captionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  // One rAF drives everything DOM-side: smooth the scroll progress, place captions,
  // light words up. The canvas reads the same smoothed value for its uniforms.
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const sectionPx = window.innerHeight * (SECTION_VH / 100);
      const raw = window.scrollY / sectionPx;
      smRef.current += (raw - smRef.current) * SM_EASE;
      const p = smRef.current;

      captionRefs.current.forEach((el, i) => {
        if (!el) return;
        const d = p - (i + 0.2); // caption i "lives" around p = i .. i+0.45
        const vis = 1 - Math.min(Math.max((Math.abs(d) - 0.3) / 0.15, 0), 1);
        el.style.opacity = String(vis);
        // drift on the INNER element — the container's transform does the centering
        const inner = el.firstElementChild as HTMLElement | null;
        if (inner) inner.style.transform = `translateY(${(-d * 34).toFixed(1)}px)`;
        if (vis > 0) {
          const words = el.querySelectorAll<HTMLSpanElement>("[data-word]");
          const rev = Math.min(Math.max((p - i + 0.15) / 0.5, 0), 1);
          const lit = Math.floor(rev * words.length);
          words.forEach((w, wi) => {
            w.style.opacity = wi < lit ? "1" : "0.14";
          });
          // body copy slides in once the headline is mostly lit
          const body = el.querySelector<HTMLParagraphElement>("[data-body]");
          if (body) {
            const on = rev > 0.55;
            body.style.opacity = on ? "1" : "0";
            body.style.transform = on ? "translateY(0)" : "translateY(10px)";
          }
        }
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  // Reduced motion: no canvas, captions as a plain readable column (rule 6 — the page
  // must survive without the WebGL layer).
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
              style={{ color: SHAPE_PALETTES[i]!.css }}
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
      {/* fixed particle stage */}
      <div className="fixed inset-0">
        <Canvas
          camera={{ position: [0, 0.4, 9], fov: 45 }}
          dpr={[1, 1.5]}
          gl={{ antialias: false, powerPreference: "high-performance" }}
        >
          <color attach="background" args={[light.bg]} />
          <CameraRig smRef={smRef} />
          <MorphCloud smRef={smRef} />
        </Canvas>
      </div>

      {/* minimal brand row (our type, not the reference's) */}
      <header className="fixed left-8 top-6 z-10 text-xs font-bold leading-tight">
        <div>Professorship of Photogrammetry and Remote Sensing</div>
        <div style={{ color: "var(--gt-text-secondary)" }}>Scroll-morph experiment</div>
      </header>

      {/* content cards — one news page per shape, each parked in its own corner */}
      {CONTENT.map((c, i) => (
        <ContentCard
          key={c.title}
          item={c}
          accent={SHAPE_PALETTES[i]!.css}
          refCb={(el) => {
            captionRefs.current[i] = el;
          }}
        />
      ))}

      {/* scroll runway: one FULL section per shape — the last section's extra length is
          what lets the finale finish assembling and its caption fully light up */}
      <div style={{ height: `${SHAPE_COUNT * SECTION_VH}vh` }} />
    </div>
  );
}
