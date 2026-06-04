import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { light } from "@groundtruth/tokens";
import { A, A_BLUES } from "./assetColors";
import { POINT_VERT, POINT_FRAG } from "./pointMorphShader";

const N = 16000; // approx total particles (distributed across all parts by area)
const MAX_H = 3.4;

type ProgressRef = { current: number };

/* ---- cheap 3D value noise (non-uniform density + jitter) ---- */
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

/* ---- Pluggable scene elements: each = some meshes (parts) with a tint. Add satellite /
   car / drone later by pushing more elements; they sample into the same point cloud. ---- */
interface Part {
  mesh: THREE.Mesh;
  area: number;
  tint: THREE.Color;
}
interface SceneElement {
  name: string;
  parts: Part[];
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
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.translate(
        cx + THREE.MathUtils.randFloatSpread(cell * 0.2),
        h / 2,
        cz + THREE.MathUtils.randFloatSpread(cell * 0.2),
      );
      // mainly blue, with ~30% near-black "ink" buildings for structure/contrast
      const tint =
        Math.random() < 0.3
          ? A.ink.clone()
          : A_BLUES[Math.floor(Math.random() * A_BLUES.length)]!.clone();
      parts.push({ mesh: new THREE.Mesh(geo), area: 2 * (w * h + w * d + h * d), tint });
    }
  }
  return { name: "city", parts };
}

function buildElements(): SceneElement[] {
  // Future: [buildCityElement(), buildSatelliteElement(), buildCarElement(), ...]
  return [buildCityElement()];
}

function PointCity({ progressRef }: { progressRef: ProgressRef }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const sprite = useMemo(makeSprite, []);

  const geom = useMemo(() => {
    const parts = buildElements().flatMap((e) => e.parts);
    const totalArea = parts.reduce((s, p) => s + p.area, 0);
    const target: number[] = [];
    const sizes: number[] = [];
    const colors: number[] = [];
    const tmp = new THREE.Vector3();
    const tmpCol = new THREE.Color();

    for (const part of parts) {
      const want = Math.max(8, Math.round((N * part.area) / totalArea));
      const sampler = new MeshSurfaceSampler(part.mesh).build();
      let got = 0;
      let guard = 0;
      while (got < want && guard < want * 6) {
        guard++;
        sampler.sample(tmp);
        const n = vnoise(tmp.x * 1.6 + 11, tmp.y * 1.6, tmp.z * 1.6 - 5);
        if (Math.random() > 0.4 + 0.6 * n) continue; // density clumps/voids
        tmpCol.copy(part.tint); // flat tint (no height brightening on a light bg)
        const jit = 0.015 + n * 0.05;
        target.push(
          tmp.x + THREE.MathUtils.randFloatSpread(jit * 2),
          tmp.y + THREE.MathUtils.randFloatSpread(jit * 2),
          tmp.z + THREE.MathUtils.randFloatSpread(jit * 2),
        );
        sizes.push(0.4 + Math.random() * Math.random() * 1.6);
        colors.push(tmpCol.r, tmpCol.g, tmpCol.b);
        got++;
      }
      part.mesh.geometry.dispose();
    }

    const count = sizes.length;
    const scatter = new Float32Array(count * 3);
    const rand = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const tx = target[i * 3]!;
      const ty = target[i * 3 + 1]!;
      const tz = target[i * 3 + 2]!;
      // dispersed state = blown to the RIGHT into trailing wisps
      const blow = 2 + Math.random() * 8;
      scatter[i * 3] = tx + blow;
      scatter[i * 3 + 1] = ty + (Math.random() - 0.5) * blow * 0.55;
      scatter[i * 3 + 2] = tz + (Math.random() - 0.5) * blow * 0.45;
      rand[i] = Math.random();
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(scatter, 3));
    g.setAttribute("aTarget", new THREE.Float32BufferAttribute(target, 3));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    g.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({
      uProgress: { value: 1 },
      uSize: { value: 0.3 },
      uMap: { value: sprite },
    }),
    [sprite],
  );

  useFrame(() => {
    const u = matRef.current?.uniforms.uProgress;
    if (u) u.value += ((progressRef.current ?? 0) - u.value) * 0.08;
  });

  return (
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
  );
}

export function Scene({ progressRef }: { progressRef: ProgressRef }) {
  return (
    <Canvas
      camera={{ position: [0, 3, 8.5], fov: 45 }}
      gl={{ antialias: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      {/* light background — the home page is light */}
      <color attach="background" args={[light.bg]} />
      <PointCity progressRef={progressRef} />
      <OrbitControls enablePan={false} enableZoom={false} target={[0, 1, 0]} />
    </Canvas>
  );
}
