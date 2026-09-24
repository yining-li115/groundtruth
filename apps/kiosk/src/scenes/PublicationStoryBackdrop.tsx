import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  loadImageParticles,
  morphFragmentShader,
  morphNoise,
  morphVertexShader,
  setMorphPair,
  type ParticleFrame,
} from "../experiments/story/imageParticles";
import "./publicationStoryBackdrop.css";

/**
 * Each detail shelf owns five authored pictures and reuses them as particle destinations.
 * Every adjacent item selects the next destination; after the fifth it loops back to the first.
 * That makes every pager action visibly reform the scene instead of nudging one bitmap.
 */
const PUBLICATION_STORY_URLS = [
  "/publications/story-act-capture.png",
  "/publications/story-act-reconstruct.png",
  "/publications/story-act-understand.png",
  "/publications/story-act-action.png",
  "/publications/story-act-observe.png",
] as const;

const PROJECT_STORY_URLS = [
  "/projects/story-idea.png",
  "/projects/story-prototype.png",
  "/projects/story-build.png",
  "/projects/story-test.png",
  "/projects/story-demo.png",
] as const;

const MORPH_MS = 1_050;
const IMAGE_PARTICLE_COUNT = 64_000;
const ARROW_PARTICLE_COUNT = 5_760;
const PARTICLE_COUNT = IMAGE_PARTICLE_COUNT + ARROW_PARTICLE_COUNT;
const CAMERA_FOV = 45;
const CAMERA_Z = 6;
const PARTICLE_SCALE = 5.05;

type StoryVariant = "publication" | "project";

type StoryLoadState = "loading" | "ready" | "degraded";

interface ParticleEngine {
  transitionTo: (frame: number, direction: -1 | 1, reduced: boolean) => void;
  dispose: () => void;
}

function wrapFrame(index: number, count: number): number {
  return ((index % count) + count) % count;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

/** Capture the exact visible in-between cloud before redirecting a rapid second page turn. */
function mixFrame(a: ParticleFrame, b: ParticleFrame, amount: number): ParticleFrame {
  const t = clamp01(amount);
  const positions = new Float32Array(a.positions.length);
  const colors = new Float32Array(a.colors.length);
  for (let i = 0; i < positions.length; i += 1) {
    positions[i] = a.positions[i]! + (b.positions[i]! - a.positions[i]!) * t;
  }
  for (let i = 0; i < colors.length; i += 1) {
    colors[i] = a.colors[i]! + (b.colors[i]! - a.colors[i]!) * t;
  }
  return { positions, colors };
}

/**
 * Fit each authored side independently into the visible edge band.
 *
 * The five source pictures do not reserve exactly the same horizontal amount for their left
 * and right subjects. A global CSS enlargement tried to hide that, but it cropped the outermost
 * part of the right scene — precisely where several pictures keep their tall structures. This
 * keeps every source particle, while mapping each side's own robust x-range to the same band.
 */
function fitParticleSideBands(frames: ParticleFrame[], viewportAspect: number): ParticleFrame[] {
  // The pictures are authored at 16:9, but the installation viewport is commonly closer to
  // 2:1. A fixed ±0.885 therefore leaves black gutters. Derive the visible world-space edge
  // from the actual perspective camera and push the outer 1% just beyond it.
  const visibleEdge =
    (Math.tan((CAMERA_FOV * Math.PI) / 360) * CAMERA_Z * viewportAspect) / PARTICLE_SCALE +
    0.012;
  const TARGET_LEFT: readonly [number, number] = [-visibleEdge, -0.4];
  const TARGET_RIGHT: readonly [number, number] = [0.4, visibleEdge];

  for (const frame of frames) {
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < IMAGE_PARTICLE_COUNT; i += 1) {
      const x = frame.positions[i * 3]!;
      if (x < 0) left.push(x);
      else if (x > 0) right.push(x);
    }

    for (const [samples, target] of [
      [left, TARGET_LEFT],
      [right, TARGET_RIGHT],
    ] as const) {
      if (samples.length < 2) continue;
      samples.sort((a, b) => a - b);
      const sourceMin = samples[Math.floor(samples.length * 0.01)]!;
      const sourceMax = samples[Math.floor(samples.length * 0.99)]!;
      const sourceSpan = Math.max(sourceMax - sourceMin, 1e-4);
      const targetSpan = target[1] - target[0];

      for (let i = 0; i < IMAGE_PARTICLE_COUNT; i += 1) {
        const offset = i * 3;
        const x = frame.positions[offset]!;
        const belongs = target[1] < 0 ? x < 0 : x > 0;
        if (!belongs) continue;
        const fitted = target[0] + ((x - sourceMin) / sourceSpan) * targetSpan;
        frame.positions[offset] = Math.min(Math.max(fitted, target[0]), target[1]);
      }
    }
  }
  return frames;
}

/**
 * Add a tiny, fixed cloud for the two navigation chevrons.
 *
 * These are not an SVG or a glowing DOM layer placed over the picture. They are 5,760 extra
 * points in the same BufferGeometry as the story image. Because those points occupy the same
 * coordinates in every authored frame, the chevrons stay legible while all 64k image particles
 * reform around them. The buttons themselves remain transparent hit regions.
 */
function addPersistentParticleArrows(
  frames: ParticleFrame[],
  variant: StoryVariant,
): ParticleFrame[] {
  const perSide = ARROW_PARTICLE_COUNT / 2;
  const perChevron = perSide / 2;
  const perStroke = perChevron / 2;
  const start = IMAGE_PARTICLE_COUNT;

  return frames.map((source) => {
    // Arrows are additive. The former implementation rewrote the last 5,760 image particles;
    // Morton ordering places that tail in the upper-right, which is why publication scenes
    // lost their drone/satellite/building detail there. Preserve all 64k authored particles.
    const frame: ParticleFrame = {
      positions: new Float32Array(PARTICLE_COUNT * 3),
      colors: new Float32Array(PARTICLE_COUNT * 3),
    };
    frame.positions.set(source.positions);
    frame.colors.set(source.colors);
    for (let side = 0; side < 2; side += 1) {
      const left = side === 0;
      for (let local = 0; local < perSide; local += 1) {
        const chevron = Math.floor(local / perChevron);
        const withinChevron = local % perChevron;
        const upperStroke = withinChevron < perStroke;
        const strokeIndex = withinChevron % perStroke;
        const t = perStroke <= 1 ? 0 : strokeIndex / (perStroke - 1);
        const particle = start + side * perSide + local;
        const offset = particle * 3;

        // Large double chevrons with a dense cyan-white core and a looser particle halo. Their
        // coordinates are identical in every frame, so they stay readable during every morph.
        const outerVertex = left ? -0.795 : 0.795;
        const vertexX = outerVertex + (left ? 0.07 : -0.07) * chevron;
        const endpointX = vertexX + (left ? 0.1 : -0.1);
        const centreY = 0.075;
        const endpointY = centreY + (upperStroke ? 0.135 : -0.135);
        const baseX = endpointX + (vertexX - endpointX) * t;
        const baseY = endpointY + (centreY - endpointY) * t;
        const dx = vertexX - endpointX;
        const dy = centreY - endpointY;
        const length = Math.hypot(dx, dy) || 1;
        const hash = ((local * 73 + side * 29 + chevron * 11) % 997) / 996;
        const halo = local % 7 === 0;
        const thickness = (hash * 2 - 1) * (halo ? 0.018 : 0.0085);
        const along = ((((local * 41 + side * 13) % 101) / 100) - 0.5) * 0.004;
        frame.positions[offset] = baseX + (-dy / length) * thickness + (dx / length) * along;
        frame.positions[offset + 1] = baseY + (dx / length) * thickness + (dy / length) * along;
        frame.positions[offset + 2] = 0;

        const warmAccent = local % 29 === 0;
        const secondaryAccent = variant === "project" && local % 17 === 0;
        if (warmAccent) {
          frame.colors[offset] = 1;
          frame.colors[offset + 1] = variant === "project" ? 0.38 : 0.58;
          frame.colors[offset + 2] = 0.12;
        } else if (secondaryAccent) {
          frame.colors[offset] = 0.7;
          frame.colors[offset + 1] = 1;
          frame.colors[offset + 2] = 0.08;
        } else if (halo) {
          frame.colors[offset] = 0.04;
          frame.colors[offset + 1] = 0.45;
          frame.colors[offset + 2] = 1;
        } else {
          const whiteCore = local % 3 !== 0;
          frame.colors[offset] = whiteCore ? 0.78 : 0.08;
          frame.colors[offset + 1] = whiteCore ? 0.97 : 0.8;
          frame.colors[offset + 2] = 1;
        }
      }
    }
    return frame;
  });
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function buildEngine(
  host: HTMLDivElement,
  frames: ParticleFrame[],
  initialFrame: number,
  onTransitionState: (moving: boolean) => void,
): ParticleEngine {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35));
  renderer.setSize(host.clientWidth, host.clientHeight, false);
  renderer.domElement.className = "detail-particle-story__canvas";
  renderer.domElement.setAttribute("data-story-canvas", "true");
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    host.clientWidth / host.clientHeight,
    0.1,
    100,
  );
  camera.position.z = CAMERA_Z;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3),
  );
  const { seedA, seedB } = morphNoise(PARTICLE_COUNT);
  geometry.setAttribute("swirl", new THREE.BufferAttribute(seedA, 3));
  geometry.setAttribute("stagger", new THREE.BufferAttribute(seedB, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: 1 },
      uSize: { value: 2.05 },
      uScale: { value: PARTICLE_SCALE },
      uSpread: { value: 0.24 },
      uDpr: { value: Math.min(window.devicePixelRatio, 1.35) },
      uRefZ: { value: CAMERA_Z },
      uTime: { value: 0 },
      uChurn: { value: 0 },
      uDim: { value: 0.28 },
    },
    vertexShader: morphVertexShader,
    fragmentShader: morphFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  let disposed = false;
  let animationFrame = 0;
  let from = frames[initialFrame]!;
  let to = frames[initialFrame]!;
  let targetFrame = initialFrame;
  let startedAt = 0;
  let currentAmount = 1;

  const render = () => renderer.render(scene, camera);
  setMorphPair(geometry, from, to);
  render();

  const stopAnimation = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };

  const animate = (now: number) => {
    if (disposed) return;
    const linear = clamp01((now - startedAt) / MORPH_MS);
    currentAmount = easeInOutCubic(linear);
    material.uniforms.uT!.value = currentAmount;
    material.uniforms.uTime!.value = now / 1_000;
    render();

    if (linear < 1) {
      animationFrame = requestAnimationFrame(animate);
      return;
    }

    from = to;
    currentAmount = 1;
    animationFrame = 0;
    onTransitionState(false);
    // Render exactly once at the settled endpoint, then leave the GPU idle until the next page.
    setMorphPair(geometry, from, from);
    material.uniforms.uT!.value = 1;
    render();
  };

  const transitionTo = (frame: number, direction: -1 | 1, reduced: boolean) => {
    const nextFrame = wrapFrame(frame, frames.length);
    if (nextFrame === targetFrame && currentAmount >= 1) return;

    // Do not snap if a second pager input arrives before the first morph has landed.
    if (currentAmount < 1) from = mixFrame(from, to, currentAmount);
    else from = to;
    to = frames[nextFrame]!;
    targetFrame = nextFrame;
    stopAnimation();
    setMorphPair(geometry, from, to);

    if (reduced) {
      material.uniforms.uT!.value = 1;
      currentAmount = 1;
      from = to;
      setMorphPair(geometry, from, from);
      onTransitionState(false);
      render();
      return;
    }

    // The same cloud travels both ways; direction changes the arc so Previous visibly reverses
    // the page relationship without assigning particles to unrelated far-away destinations.
    const swirl = geometry.getAttribute("swirl") as THREE.BufferAttribute;
    const values = swirl.array as Float32Array;
    for (let i = 0; i < values.length; i += 3) {
      values[i] = Math.abs(values[i]!) * direction;
    }
    swirl.needsUpdate = true;

    material.uniforms.uT!.value = 0;
    currentAmount = 0;
    startedAt = performance.now();
    onTransitionState(true);
    animationFrame = requestAnimationFrame(animate);
  };

  const resize = () => {
    if (disposed || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  return {
    transitionTo,
    dispose: () => {
      disposed = true;
      stopAnimation();
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function DetailParticleStoryBackdrop({
  index,
  direction,
  urls,
  variant,
}: {
  index: number;
  direction: -1 | 1;
  urls: readonly string[];
  variant: StoryVariant;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ParticleEngine | null>(null);
  const desiredRef = useRef({ frame: wrapFrame(index, urls.length), direction });
  const reduced = useReducedMotion();
  const [loadState, setLoadState] = useState<StoryLoadState>("loading");
  const [moving, setMoving] = useState(false);
  const frame = wrapFrame(index, urls.length);
  desiredRef.current = { frame, direction };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    void Promise.all(
      urls.map((url) =>
        loadImageParticles(url, IMAGE_PARTICLE_COUNT, {
          minLuma: 0.085,
          gamma: 0.62,
          sampleWidth: 520,
          align: false,
          autoExposure: true,
        }),
      ),
    )
      .then((frames) => {
        if (cancelled) return;
        const desired = desiredRef.current;
        engineRef.current = buildEngine(
          host,
          addPersistentParticleArrows(
            fitParticleSideBands(frames, host.clientWidth / host.clientHeight),
            variant,
          ),
          desired.frame,
          setMoving,
        );
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(`${variant} particle story failed to load`, error);
        setLoadState("degraded");
      });

    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [urls, variant]);

  useEffect(() => {
    engineRef.current?.transitionTo(frame, direction, reduced);
  }, [direction, frame, reduced]);

  return (
    <div
      ref={hostRef}
      className={`detail-particle-story ${variant}-story`}
      data-story-particle-arrows="persistent"
      data-story-image-particles={IMAGE_PARTICLE_COUNT}
      data-story-arrow-particles={ARROW_PARTICLE_COUNT}
      data-story-total-particles={PARTICLE_COUNT}
      data-story-side-fit="normalized"
      data-story-direction={direction}
      data-story-frame={frame}
      data-story-frame-count={urls.length}
      data-story-index={index}
      data-story-reduced={reduced ? "true" : "false"}
      data-story-state={loadState}
      data-story-transition={moving ? "morphing" : "settled"}
      aria-hidden
    >
      {loadState !== "ready" && (
        <img
          className="detail-particle-story__fallback"
          data-story-fallback
          src={urls[frame]}
          alt=""
          decoding="async"
          draggable={false}
        />
      )}
    </div>
  );
}

export function PublicationStoryBackdrop({
  index,
  direction,
}: {
  index: number;
  direction: -1 | 1;
}) {
  return (
    <DetailParticleStoryBackdrop
      index={index}
      direction={direction}
      urls={PUBLICATION_STORY_URLS}
      variant="publication"
    />
  );
}

export function ProjectStoryBackdrop({
  index,
  direction,
}: {
  index: number;
  direction: -1 | 1;
}) {
  return (
    <DetailParticleStoryBackdrop
      index={index}
      direction={direction}
      urls={PROJECT_STORY_URLS}
      variant="project"
    />
  );
}
