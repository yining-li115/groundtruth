import { useEffect, useRef } from "react";
import * as THREE from "three";
import { dark, light } from "@groundtruth/tokens";
import {
  loadActField,
  morphNoise,
  morphVertexShader,
  morphFragmentShader,
  setMorphPair,
  type ParticleFrame,
} from "./imageParticles";

/**
 * The story showreel as scroll-driven 2D particles (/?exp=story).
 *
 * The visitor decides how fast the story moves. Each act owns one section of scroll runway:
 * through the first part of it the act's own frames scrub past — chain-generated poses of one
 * continuous motion, so the particles read as something happening rather than as a
 * cross-fade — while its caption reveals character by character. The caption finishes exactly
 * as the act reaches its final frame. The rest of the section carries that frame into the next
 * act's opening one and takes the caption back out.
 *
 * Timing is deliberately NOT on a clock. An unattended screen can autoplay later, but
 * scrubbing is what lets someone stop and read, and the captions exist to be read. Home B
 * (HomeFly) works this way and the choreography here follows it.
 *
 * Source frames come from `scripts/gen-frames.mjs` and live in public/story/.
 */

const PARAMS = typeof window === "undefined" ? null : new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(PARAMS?.get(k));
  return Number.isFinite(v) && PARAMS?.get(k) !== null ? v : d;
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const COUNT = num("count", 320_000);
const POINT_SIZE = num("size", 1.9);
const BLEND = PARAMS?.get("blend") ?? "normal";
// The frames are night photography — bright structure out of black. Inverting them for a
// light ground turns them into negatives, so the dark theme is the honest default for this
// material; `?theme=light` is still there for when the frames are made dark-on-white.
// Light, like the rest of this site and like the reference: a pale ground with dark ink dots,
// where density carries the picture. `?theme=dark` keeps the bright-on-black variant.
const THEME = PARAMS?.get("theme") === "dark" ? "dark" : "light";
const TOKENS = THEME === "dark" ? dark : light;
const INK = THEME === "light";

/** Scroll runway per act, in vh. Longer = the story moves less under the same flick. */
const SECTION_VH = num("section", 160);
/**
 * How much of an act's section is spent on the act itself; the rest is the hand-off to the
 * next one. So the caption has finished and the picture is already on the act's last frame
 * before anything starts turning into the next thing.
 */
const ACT_SPAN = num("span", 0.72);
const SM_EASE = 0.16; // scroll smoothing, matching Home B's feel

/**
 * Each act is a short LOOP, not a progression. Three poses of one motion, cycled on a clock,
 * is what makes a subject look alive — the same way three drawings make a character run. A
 * long one-way sequence scrubbed by scroll is a different thing entirely: it stops dead the
 * moment the visitor stops scrolling, and no amount of extra frames makes it move.
 *
 * Scroll advances BETWEEN acts. Within an act, the loop runs by itself.
 */
const STORY: { act: string; caption: string; frames: string[] }[] = [
  {
    act: "sensing",
    caption: "Light becomes measurement",
    frames: ["sn1", "sn2", "sn3", "sn2"],
  },
  {
    act: "points",
    caption: "Measurement becomes points",
    frames: ["pt1", "pt2", "pt3", "pt2"],
  },
  {
    act: "semantics",
    caption: "Points become meaning",
    frames: ["sm1", "sm2", "sm3", "sm2"],
  },
  {
    act: "change",
    caption: "Meaning becomes change over time",
    frames: ["ch1", "ch2", "ch3", "ch2"],
  },
  {
    act: "robotics",
    caption: "Understanding becomes action",
    // ping-pong: the displacement is measured forward through the sequence, so returning the
    // way it came is what closes the loop without a jump
    frames: ["rb1", "rb2", "rb3", "rb2"],
  },
];

/** seconds per pose in an act's loop */
const LOOP_S = num("loop", 0.55);
/**
 * Two kinds of movement, and they must not share settings.
 *
 * Pose to pose inside a loop is MOTION: particles shift a little and nothing else changes.
 * Giving it the act-to-act treatment — a wide outward bulge plus a dip in brightness — turns
 * every cycle into a pulse, and a pulse repeating twice a second is precisely the flicker.
 *
 * Act to act is a TRANSFORMATION: the swarm is meant to break up and reassemble as something
 * else, so there the bulge and the dimming are the point.
 */
const POSE_SPREAD = num("posespread", 0.0);
const POSE_DIM = num("posedim", 0.0);
/**
 * Fraction of a pose's time spent moving to the next one, now that the poses share one set of
 * particles carried along by the measured displacement. Interpolating between them is no
 * longer a cross-fade between two unrelated clouds — it IS the motion, each particle sliding
 * along the path its bit of the subject took. So: fully tweened. `?posemorph=0.1` gets the
 * held-frame flipbook back.
 */
const POSE_MORPH = num("posemorph", 1.0);
const ACT_SPREAD = num("spread", 0.35);
const ACT_DIM = num("actdim", 0.35);

/** index of each act's first frame within the flat list */
const ACT_START: number[] = [];
STORY.reduce((n, a) => {
  ACT_START.push(n);
  return n + a.frames.length;
}, 0);

export function StoryExperiment() {
  const hostRef = useRef<HTMLDivElement>(null);
  const capRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(new THREE.Color(TOKENS.bg), 1);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.z = 6;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    const { seedA, seedB } = morphNoise(COUNT);
    geo.setAttribute("swirl", new THREE.BufferAttribute(seedA, 3));
    geo.setAttribute("stagger", new THREE.BufferAttribute(seedB, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: 0 },
        uSize: { value: POINT_SIZE },
        uScale: { value: 5.2 },
        uSpread: { value: POSE_SPREAD },
        uDpr: { value: Math.min(window.devicePixelRatio, 2) },
        uRefZ: { value: 6 },
        uTime: { value: 0 },
        uChurn: { value: num("churn", 0.004) },
        uDim: { value: 0 },
      },
      vertexShader: morphVertexShader,
      fragmentShader: morphFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: BLEND === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    scene.add(new THREE.Points(geo, mat));

    let frames: ParticleFrame[] = [];
    let pair = -1; // which A→B pair the geometry currently holds
    let sm = 0; // smoothed scroll position, measured in acts

    (async () => {
      // Per ACT, not across the whole story: displacement is only meaningful inside one
      // continuous motion. Measuring it from a drone to a stone facade would just produce
      // noise. Between acts the picture genuinely becomes something else, and the swarm is
      // supposed to break up and reassemble there.
      const perAct = await Promise.all(
        STORY.map((a) => loadActField(a.frames.map((id) => `/story/${id}.png`), COUNT, { ink: INK })),
      );
      frames = perAct.flat();
      if (!disposed && frames.length >= 2) setMorphPair(geo, frames[0]!, frames[1]!);
    })();

    const tick = () => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);

      mat.uniforms.uTime!.value = performance.now() / 1000;
      const sectionPx = window.innerHeight * (SECTION_VH / 100);
      sm += (window.scrollY / sectionPx - sm) * SM_EASE;

      if (frames.length >= 2) {
        const ai = Math.min(Math.max(Math.floor(sm), 0), STORY.length - 1);
        const within = clamp01(sm - ai);
        const n = STORY[ai]!.frames.length;
        const base = ACT_START[ai] ?? 0;

        let a: number;
        let b: number;
        let t: number;
        if (within <= ACT_SPAN || ai + 1 >= STORY.length) {
          // Inside the act: cycle its poses on the clock. `% n` closes the loop, so the last
          // pose flows back into the first instead of snapping.
          const u = (performance.now() / 1000 / LOOP_S) % n;
          const k = Math.floor(u);
          a = base + k;
          b = base + ((k + 1) % n);
          // hold the pose, then switch near the end of its slot
          const f = u - k;
          t = POSE_MORPH <= 0 ? 0 : clamp01((f - (1 - POSE_MORPH)) / POSE_MORPH);
          mat.uniforms.uSpread!.value = POSE_SPREAD;
          mat.uniforms.uDim!.value = POSE_DIM;
        } else {
          // Hand-off: whichever pose the loop is on, carried into the next act's first frame.
          const u = (performance.now() / 1000 / LOOP_S) % n;
          a = base + Math.floor(u);
          b = ACT_START[ai + 1] ?? a;
          t = clamp01((within - ACT_SPAN) / (1 - ACT_SPAN));
          mat.uniforms.uSpread!.value = ACT_SPREAD;
          mat.uniforms.uDim!.value = ACT_DIM;
        }

        const key = a * 1000 + b;
        if (key !== pair) {
          setMorphPair(geo, frames[a]!, frames[b]!);
          pair = key;
        }
        mat.uniforms.uT!.value = t;

        // Captions: reveal across the act's own span, so the last character lands exactly as
        // the animation reaches its final frame; then withdraw during the hand-off.
        capRefs.current.forEach((el, ci) => {
          if (!el) return;
          const d = sm - ci;
          const reveal = clamp01(d / ACT_SPAN);
          const gone = clamp01((d - ACT_SPAN) / (1 - ACT_SPAN));
          el.style.opacity = String(clamp01(d + 0.15) * (1 - gone));
          const chars = el.querySelectorAll<HTMLElement>("[data-char]");
          const nc = chars.length;
          const W = 6; // soft window sweeping the line, the classic hero's feel
          chars.forEach((c, k) => {
            const v = clamp01((reveal * (nc + W) - k) / W);
            c.style.opacity = (0.05 + 0.95 * v).toFixed(3);
            c.style.filter = v >= 1 ? "none" : `blur(${((1 - v) * 10).toFixed(1)}px)`;
          });
        });
      }

      renderer.render(scene, camera);
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
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div style={{ background: TOKENS.bg }}>
      {/* the picture is pinned; the runway below is what actually scrolls */}
      <div ref={hostRef} className="fixed inset-0" />

      {STORY.map((s, i) => (
        <div
          key={s.act}
          ref={(el) => {
            capRefs.current[i] = el;
          }}
          className="pointer-events-none fixed inset-x-0 bottom-0 px-16 pb-20"
          style={{ opacity: 0 }}
        >
          <div
            className="mb-3 text-xs font-bold uppercase tracking-[0.2em]"
            style={{ color: TOKENS.accent }}
          >
            {s.act}
          </div>
          <h2
            className="max-w-3xl text-5xl font-bold leading-tight"
            style={{ color: TOKENS.text.primary }}
          >
            {Array.from(s.caption).map((ch, k) => (
              <span key={k} data-char style={{ display: "inline-block", whiteSpace: "pre" }}>
                {ch}
              </span>
            ))}
          </h2>
        </div>
      ))}

      {/* scroll runway: one section per act, plus a tail so the last act can finish */}
      <div style={{ height: `${STORY.length * SECTION_VH + 60}vh` }} />
    </div>
  );
}
