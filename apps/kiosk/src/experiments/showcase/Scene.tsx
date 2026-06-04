import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { light } from "@groundtruth/tokens";
import { A } from "./assetColors";
import { POINT_VERT, POINT_FRAG } from "./pointMorphShader";

const N = 140000; // total particles (denser city so its features read like the sat/car)
const MAX_H = 3.4;
/** On the home, shift the whole assembly right so the motto (overlaid left) stays clear. */
const HOME_OFFSET_X = 2.6;

type ProgressRef = { current: number };
type Mode = "home" | "inspect";

/* ---- cheap 3D value noise (jitter) ---- */
const hash = (x: number, y: number, z: number) => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
};
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
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

/* ---- Pluggable scene elements (city / satellite / car / …). ---- */
interface Part {
  mesh: THREE.Mesh;
  area: number;
}
interface SceneElement {
  name: string;
  parts: Part[];
  share: number;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): Part {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return { mesh: new THREE.Mesh(geo), area: 2 * (w * h + w * d + h * d) };
}

function buildCityElement(): SceneElement {
  const parts: Part[] = [];
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
      const w = cell * THREE.MathUtils.randFloat(0.45, 0.82);
      const d = cell * THREE.MathUtils.randFloat(0.45, 0.82);
      parts.push(
        box(
          w,
          h,
          d,
          cx + THREE.MathUtils.randFloatSpread(cell * 0.2),
          h / 2,
          cz + THREE.MathUtils.randFloatSpread(cell * 0.2),
        ),
      );
    }
  }
  return { name: "city", parts, share: 8 };
}

function buildSatelliteElement(bx: number, by: number, bz: number): SceneElement {
  return {
    name: "satellite",
    share: 1,
    parts: [
      box(0.5, 0.5, 0.5, bx, by, bz),
      box(0.95, 0.03, 0.45, bx - 0.78, by, bz),
      box(0.95, 0.03, 0.45, bx + 0.78, by, bz),
      box(0.05, 0.45, 0.05, bx, by + 0.42, bz),
    ],
  };
}

function buildCarElement(bx: number, by: number, bz: number): SceneElement {
  const wheel = (dx: number, dz: number) => box(0.16, 0.16, 0.12, bx + dx, by + 0.08, bz + dz);
  return {
    name: "car",
    share: 1.4,
    parts: [
      box(0.95, 0.22, 0.46, bx, by + 0.16, bz),
      box(0.5, 0.22, 0.42, bx, by + 0.4, bz),
      wheel(-0.34, 0.19),
      wheel(0.34, 0.19),
      wheel(-0.34, -0.19),
      wheel(0.34, -0.19),
    ],
  };
}

function buildElements(): SceneElement[] {
  return [
    buildCityElement(),
    buildSatelliteElement(-1.6, 4.4, -1),
    buildSatelliteElement(2.0, 3.7, -2),
    // car: on the ground (same level as the buildings), pulled further out front-left
    buildCarElement(-3.2, 0, 3.4),
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
  const sprite = useMemo(makeSprite, []);

  const geom = useMemo(() => {
    const elements = buildElements();
    const totalShare = elements.reduce((s, e) => s + e.share, 0);
    const target: number[] = [];
    const sizes: number[] = [];
    const tmp = new THREE.Vector3();

    for (const el of elements) {
      const elemArea = el.parts.reduce((s, p) => s + p.area, 0) || 1;
      const budget = (N * el.share) / totalShare;
      for (const part of el.parts) {
        const want = Math.max(6, Math.round((budget * part.area) / elemArea));
        const sampler = new MeshSurfaceSampler(part.mesh).build();
        for (let k = 0; k < want; k++) {
          sampler.sample(tmp);
          const n = vnoise(tmp.x * 1.6 + 11, tmp.y * 1.6, tmp.z * 1.6 - 5);
          const jit = 0.01 + n * 0.04;
          target.push(
            tmp.x + THREE.MathUtils.randFloatSpread(jit * 2),
            tmp.y + THREE.MathUtils.randFloatSpread(jit * 2),
            tmp.z + THREE.MathUtils.randFloatSpread(jit * 2),
          );
          sizes.push(0.4 + Math.random() * Math.random() * 1.6);
        }
        part.mesh.geometry.dispose();
      }
    }

    // Remote-sensing data lines: scattered points along sensor → city (acquisition).
    const addLine = (
      fx: number, fy: number, fz: number,
      tx: number, ty: number, tz: number,
      n: number,
    ) => {
      for (let k = 0; k < n; k++) {
        const t = Math.random();
        target.push(
          fx + (tx - fx) * t + THREE.MathUtils.randFloatSpread(0.06),
          fy + (ty - fy) * t + THREE.MathUtils.randFloatSpread(0.06),
          fz + (tz - fz) * t + THREE.MathUtils.randFloatSpread(0.06),
        );
        sizes.push(0.4 + Math.random() * 0.6);
      }
    };
    addLine(-1.6, 4.2, -1, -0.5, 2.4, 0, 500); // satellite 1 → city
    addLine(2.0, 3.5, -2, 0.8, 2.2, 0, 500); // satellite 2 → city
    addLine(-3.2, 0.5, 3.4, -0.6, 0.8, 0.4, 600); // car → city

    const count = sizes.length;
    const scatter = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const rand = new Float32Array(count);
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
      rand[i] = Math.random();
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(scatter, 3));
    g.setAttribute("aTarget", new THREE.Float32BufferAttribute(target, 3));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({ uProgress: { value: 1 }, uSize: { value: 0.18 }, uMap: { value: sprite } }),
    [sprite],
  );

  useFrame((state) => {
    const u = matRef.current?.uniforms.uProgress;
    if (u) u.value += ((progressRef.current ?? 0) - u.value) * 0.08;
    // gentle idle sway — an implicit "you can drag me" hint; drag (OrbitControls) layers on top
    if (idleSpin && groupRef.current) {
      groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.15) * 0.12;
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

export function Scene({ progressRef, mode = "inspect" }: { progressRef: ProgressRef; mode?: Mode }) {
  const home = mode === "home";
  return (
    <Canvas
      camera={{ position: home ? [8.59, 2.15, 4.63] : [0, 3, 9], fov: 45 }}
      gl={{ antialias: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[light.bg]} />
      <PointCity progressRef={progressRef} offsetX={home ? HOME_OFFSET_X : 0} idleSpin={home} />
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
