/**
 * GLB-sampled point-cloud scene — EXPERIMENT ONLY. Rendered solely by ShowcaseExperiment
 * at /?exp=showcase. The live home hero still uses the procedural `Scene.tsx`; this file is
 * the work-in-progress replacement (real Sketchfab models instead of boxes) and is NOT yet
 * wired into the home. Promote it into Home.tsx only when explicitly asked.
 */
import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { light } from "@groundtruth/tokens";
import { A } from "./assetColors";
import { heroOrbit } from "../../lib/heroInput";
import { POINT_VERT, POINT_FRAG } from "./pointMorphShader";
import {
  Emitter,
  footprint,
  mergeSceneGeometry,
  normalizeCentered,
  normalizeUpright,
  type Orient,
} from "./sampleModels";

const N = 140000; // total particles (denser city so its features read like the sat/car)
const MAX_H = 3.4;
/** On the home, shift the whole assembly right so the motto (overlaid left) stays clear. */
const HOME_OFFSET_X = 2.6;

type ProgressRef = { current: number };
type Mode = "home" | "inspect";

/**
 * The GLB props that make up the scene. `up` reorients each model to Y-up (Sketchfab
 * sources use mixed conventions — verify visually at /?exp=showcase and flip as needed).
 * `kind` picks the normalizer: "upright" sits on the ground (height→1), "centered" floats.
 */
const SPEC = [
  { key: "towerA", url: "/models/tower_a.glb", up: "y", kind: "upright" },
  { key: "towerB", url: "/models/tower_b.glb", up: "y", kind: "upright" },
  { key: "low", url: "/models/building_low.glb", up: "z", kind: "upright" },
  { key: "car", url: "/models/car.glb", up: "y", kind: "upright" },
  { key: "satellite", url: "/models/satellite.glb", up: "y", kind: "centered" },
  { key: "drone", url: "/models/drone.glb", up: "y", kind: "centered" },
  { key: "tree", url: "/models/tree.glb", up: "z", kind: "upright" },
] as const satisfies ReadonlyArray<{ key: string; url: string; up: Orient; kind: "upright" | "centered" }>;

const URLS = SPEC.map((s) => s.url);
URLS.forEach((u) => useGLTF.preload(u));

type ProtoKey = (typeof SPEC)[number]["key"];
interface Proto {
  emitter: Emitter;
  foot: number; // horizontal extent of the normalized prototype (for grid fitting)
}

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

/** One placed point emitter: a prototype sampler + where/how big it goes + its point share. */
interface Placement {
  proto: Proto;
  matrix: THREE.Matrix4;
  weight: number;
}

const rand = THREE.MathUtils.randFloat;
const spread = THREE.MathUtils.randFloatSpread;

/** Compose a TRS placement matrix (non-uniform scale allowed for stretched buildings). */
function place(pos: THREE.Vector3, yaw: number, scale: THREE.Vector3): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
  return new THREE.Matrix4().compose(pos, q, scale);
}

/** A 6×6 city grid: each occupied cell instances a random building prototype, scaled to a
 *  distance-falloff height and fitted to the cell footprint. Returns the placements. */
function cityPlacements(protos: Record<ProtoKey, Proto>): Placement[] {
  const out: Placement[] = [];
  const span = 5;
  const cells = 6;
  const cell = span / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      if (Math.random() < 0.22) continue;
      const cx = -span / 2 + (i + 0.5) * cell;
      const cz = -span / 2 + (j + 0.5) * cell;
      const distC = Math.hypot(cx, cz);
      const maxH = THREE.MathUtils.lerp(MAX_H, 0.8, Math.min(distC / 3, 1));
      const h = THREE.MathUtils.lerp(0.6, maxH, Math.random());
      // Center cells prefer towers; the outskirts get the low, wide building.
      const key: ProtoKey =
        distC < 1.4
          ? Math.random() < 0.5
            ? "towerA"
            : "towerB"
          : Math.random() < 0.55
            ? "low"
            : Math.random() < 0.5
              ? "towerA"
              : "towerB";
      const proto = protos[key];
      const footScale = (cell * rand(0.55, 0.82)) / proto.foot;
      const pos = new THREE.Vector3(cx + spread(cell * 0.2), 0, cz + spread(cell * 0.2));
      out.push({
        proto,
        weight: h, // taller buildings get proportionally more points
        matrix: place(pos, Math.random() * Math.PI * 2, new THREE.Vector3(footScale, h, footScale)),
      });
    }
  }
  return out;
}

/** The acquisition props (satellites / car / drone / trees) at their hand-placed spots. */
function propPlacements(protos: Record<ProtoKey, Proto>): Placement[] {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const uni = (s: number) => new THREE.Vector3(s, s, s);
  return [
    // satellites (float, centered): match the data-line endpoints below
    { proto: protos.satellite, weight: 3, matrix: place(v(-1.6, 4.4, -1), 0.4, uni(1.7)) },
    { proto: protos.satellite, weight: 3, matrix: place(v(2.0, 3.7, -2), -0.6, uni(1.5)) },
    // drone (float, centered)
    { proto: protos.drone, weight: 4, matrix: place(v(2.6, 4.2, 1.6), 0.8, uni(1.0)) },
    // autonomous car on the ground, front-left
    { proto: protos.car, weight: 4, matrix: place(v(-3.2, 0, 3.4), 0.5, uni(0.34)) },
    // trees as organic accents among the blocks
    { proto: protos.tree, weight: 2, matrix: place(v(1.7, 0, 1.4), 0, uni(0.9)) },
    { proto: protos.tree, weight: 2, matrix: place(v(-1.9, 0, -1.2), 1.2, uni(1.0)) },
  ];
}

function PointCity({
  progressRef,
  offsetX,
  idleSpin,
}: {
  progressRef: ProgressRef;
  offsetX: number;
  idleSpin: boolean;
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);
  const rot = useRef({ yaw: 0, pitch: 0, swayAmp: 0.12 });
  const sprite = useMemo(makeSprite, []);

  // useGLTF suspends until every model is loaded; the geometry is rebuilt once they're in.
  const gltfs = useGLTF(URLS);

  const geom = useMemo(() => {
    const protos = {} as Record<ProtoKey, Proto>;
    SPEC.forEach((s, i) => {
      const geo = mergeSceneGeometry(gltfs[i]!.scene);
      if (s.kind === "centered") normalizeCentered(geo, s.up);
      else normalizeUpright(geo, s.up);
      protos[s.key] = { emitter: new Emitter(geo), foot: footprint(geo) };
    });

    const placements = [...cityPlacements(protos), ...propPlacements(protos)];

    const target: number[] = [];
    const sizes: number[] = [];

    // Remote-sensing data lines: scattered points along sensor → city (acquisition).
    const addLine = (
      fx: number, fy: number, fz: number,
      tx: number, ty: number, tz: number,
      n: number,
    ) => {
      for (let k = 0; k < n; k++) {
        const t = Math.random();
        target.push(
          fx + (tx - fx) * t + spread(0.06),
          fy + (ty - fy) * t + spread(0.06),
          fz + (tz - fz) * t + spread(0.06),
        );
        sizes.push(0.4 + Math.random() * 0.6);
      }
    };
    const lineBudget = 1600; // 500 + 500 + 600

    // Distribute the remaining points across placements by weight.
    const totalW = placements.reduce((s, p) => s + p.weight, 0);
    const pointBudget = N - lineBudget;
    for (const p of placements) {
      const n = Math.max(20, Math.round((pointBudget * p.weight) / totalW));
      const before = target.length;
      p.proto.emitter.emit(n, p.matrix, target, 0.02);
      const added = (target.length - before) / 3;
      for (let k = 0; k < added; k++) sizes.push(0.4 + Math.random() * Math.random() * 1.6);
    }

    addLine(-1.6, 4.2, -1, -0.5, 2.4, 0, 500); // satellite 1 → city
    addLine(2.0, 3.5, -2, 0.8, 2.2, 0, 500); // satellite 2 → city
    addLine(-3.2, 0.5, 3.4, -0.6, 0.8, 0.4, 600); // car → city

    const count = sizes.length;
    const scatter = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const tx = target[i * 3]!;
      const ty = target[i * 3 + 1]!;
      const tz = target[i * 3 + 2]!;
      const blow = 2 + Math.random() * 8; // dispersed = blown to the RIGHT
      scatter[i * 3] = tx + blow;
      scatter[i * 3 + 1] = ty + (Math.random() - 0.5) * blow * 0.55;
      scatter[i * 3 + 2] = tz + (Math.random() - 0.5) * blow * 0.45;
      colors[i * 3] = A.point.r;
      colors[i * 3 + 1] = A.point.g;
      colors[i * 3 + 2] = A.point.b;
      rnd[i] = Math.random();
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(scatter, 3));
    g.setAttribute("aTarget", new THREE.Float32BufferAttribute(target, 3));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aRand", new THREE.BufferAttribute(rnd, 1));
    return g;
  }, [gltfs]);

  const uniforms = useMemo(
    () => ({ uProgress: { value: 1 }, uSize: { value: 0.18 }, uMap: { value: sprite } }),
    [sprite],
  );

  useFrame((state) => {
    const u = matRef.current?.uniforms.uProgress;
    if (u) u.value += ((progressRef.current ?? 0) - u.value) * 0.08;
    if (idleSpin && groupRef.current) {
      // Ease toward the phone-driven orbit target (Cursor routes one-finger drag here).
      rot.current.yaw += (heroOrbit.yaw - rot.current.yaw) * 0.1;
      rot.current.pitch += (heroOrbit.pitch - rot.current.pitch) * 0.1;
      // Idle sway is a "you can drag me" hint; fade it out once the visitor takes control.
      rot.current.swayAmp += ((heroOrbit.touched ? 0 : 0.12) - rot.current.swayAmp) * 0.05;
      const sway = Math.sin(state.clock.elapsedTime * 0.15) * rot.current.swayAmp;
      groupRef.current.rotation.y = sway + rot.current.yaw;
      groupRef.current.rotation.x = rot.current.pitch;
    }
  });

  return (
    <group ref={groupRef} position={[offsetX, 0, 0]}>
      <points geometry={geom}>
        <shaderMaterial
          ref={matRef}
          uniforms={uniforms}
          vertexShader={POINT_VERT}
          fragmentShader={POINT_FRAG}
          transparent
          depthWrite={false}
          blending={THREE.NormalBlending}
        />
      </points>
    </group>
  );
}

export function SceneModels({ progressRef, mode = "inspect" }: { progressRef: ProgressRef; mode?: Mode }) {
  const home = mode === "home";
  return (
    <Canvas
      camera={{ position: home ? [8.59, 2.15, 4.63] : [0, 3, 9], fov: 45 }}
      // Cap pixel ratio + drop MSAA: 140k soft-sprite points are fill-rate bound, so a
      // full-res retina canvas (dpr 2) stutters while scrolling. The sprites are already
      // soft, so antialias buys almost nothing here.
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[light.bg]} />
      <Suspense fallback={null}>
        <PointCity progressRef={progressRef} offsetX={home ? HOME_OFFSET_X : 0} idleSpin={home} />
      </Suspense>
      {/* drag to rotate (both modes); wheel disabled so the page still scrolls. The home
          default is the hand-picked angle that reads the whole layout at a glance. */}
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        target={home ? [1, 0.9, 0] : [0, 1, 0]}
      />
    </Canvas>
  );
}
