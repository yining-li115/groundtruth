import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { dark } from "@groundtruth/tokens";
import { heroOrbit } from "../../lib/heroInput";
import { loadBakedCloud, type BakedCloud } from "../showcase/loadBakedCloud";

// Local copy of the morph shader with a tunable `uAlpha` so the dense scan reads as a
// SOLID building when assembled (the shared home shader stays a faint dust cloud — this
// keeps the two decoupled). Same position morph + soft-sprite falloff otherwise.
const VERT = /* glsl */ `
  uniform float uProgress; uniform float uSize; uniform float uAlpha;
  attribute vec3 aTarget; attribute float aRand; attribute float aSize; attribute vec3 aColor;
  attribute float aOpacity;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    float t = clamp((uProgress - aRand * 0.25) / 0.75, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 p = mix(position, aTarget, t);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aSize * (320.0 / -mv.z);
    // per-point opacity (faint splats stay faint) × solidity ramp × global tuner
    vAlpha = (0.55 + 0.35 * t) * uAlpha * aOpacity;
    vColor = aColor;
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D uMap; varying float vAlpha; varying vec3 vColor;
  void main() {
    float m = texture2D(uMap, gl_PointCoord).a;
    gl_FragColor = vec4(vColor, m * vAlpha);
  }
`;

/**
 * Point cloud rendered from a baked Gaussian-splat scene (the TUM campus scan), used by
 * the CV interaction experiment. Reuses the home hero's morph shader + heroOrbit so the
 * touchless controls (hand → disperse via progressRef, head → orbit) drive it unchanged.
 * The procedural home Scene is intentionally left untouched — this is the decoupled
 * splat variant (promote into Home once the look is locked).
 */

const CLOUD_URL = "/splat/tum-campus.bin";

// ---- framing knobs (tune live once you see the real scan) ----
const TARGET_HALF = 3.5; // normalise any scan to roughly this half-extent (world units)
const POINT_SIZE = 0.075; // base sprite size (uSize) — smaller = finer facade detail (denser cloud)
const ALPHA = 0.9; // point opacity multiplier — higher = more solid / less see-through
// The scan's native orientation is arbitrary; nudge these if it loads tilted / upside-down.
const ROT_X = 0;
const ROT_Y = 0;
const ROT_Z = 0;

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

/** Build morph geometry from the baked cloud: centre + scale, radial scatter, real colors. */
function buildGeometry(cloud: BakedCloud): THREE.BufferGeometry {
  const { count, positions, rgba, sizes } = cloud;

  // centre on the bounding-box midpoint (predictable framing) and normalise scale
  const bMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const bMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    bMin.min(p);
    bMax.max(p);
  }
  const c = bMin.clone().add(bMax).multiplyScalar(0.5);
  const extent = Math.max(bMax.x - bMin.x, bMax.y - bMin.y, bMax.z - bMin.z) || 1;
  const scale = (TARGET_HALF * 2) / extent;
  const rot = new THREE.Euler(ROT_X, ROT_Y, ROT_Z);

  const target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  const sizeAttr = new Float32Array(count);
  const rand = new Float32Array(count);
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    v.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
      .sub(c)
      .multiplyScalar(scale)
      .applyEuler(rot);
    target[i * 3] = v.x;
    target[i * 3 + 1] = v.y;
    target[i * 3 + 2] = v.z;

    // radial burst outward from centre (open palm dispersal)
    let dx = v.x, dy = v.y, dz = v.z;
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; len = Math.hypot(dx, dy, dz) || 1; }
    const blow = 3 + Math.random() * 8;
    scatter[i * 3] = v.x + (dx / len) * blow + THREE.MathUtils.randFloatSpread(1.5);
    scatter[i * 3 + 1] = v.y + (dy / len) * blow + THREE.MathUtils.randFloatSpread(1.5);
    scatter[i * 3 + 2] = v.z + (dz / len) * blow + THREE.MathUtils.randFloatSpread(1.5);

    col[i * 3] = rgba[i * 4]! / 255;
    col[i * 3 + 1] = rgba[i * 4 + 1]! / 255;
    col[i * 3 + 2] = rgba[i * 4 + 2]! / 255;
    opacity[i] = rgba[i * 4 + 3]! / 255;
    sizeAttr[i] = sizes[i]!; // real splat footprint (median ≈ 1)
    rand[i] = Math.random();
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(scatter, 3));
  g.setAttribute("aTarget", new THREE.BufferAttribute(target, 3));
  g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aOpacity", new THREE.BufferAttribute(opacity, 1));
  g.setAttribute("aSize", new THREE.BufferAttribute(sizeAttr, 1));
  g.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
  return g;
}

function CampusPoints({
  cloud,
  progressRef,
  orbit,
}: {
  cloud: BakedCloud;
  progressRef: { current: number };
  orbit: boolean; // head-driven orbit + idle sway; off = static group so the mouse inspects
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);
  const rot = useRef({ yaw: 0, pitch: 0, swayAmp: 0.12 });
  const sprite = useMemo(makeSprite, []);
  const geom = useMemo(() => buildGeometry(cloud), [cloud]);
  const uniforms = useMemo(
    () => ({
      uProgress: { value: 1 },
      uSize: { value: POINT_SIZE },
      uAlpha: { value: ALPHA },
      uMap: { value: sprite },
    }),
    [sprite],
  );

  useFrame((state) => {
    const u = matRef.current?.uniforms.uProgress;
    if (u) u.value += ((progressRef.current ?? 0) - u.value) * 0.08;
    if (orbit && groupRef.current) {
      rot.current.yaw += (heroOrbit.yaw - rot.current.yaw) * 0.1;
      rot.current.pitch += (heroOrbit.pitch - rot.current.pitch) * 0.1;
      rot.current.swayAmp += ((heroOrbit.touched ? 0 : 0.12) - rot.current.swayAmp) * 0.05;
      const sway = Math.sin(state.clock.elapsedTime * 0.15) * rot.current.swayAmp;
      groupRef.current.rotation.y = sway + rot.current.yaw;
      groupRef.current.rotation.x = rot.current.pitch;
    }
  });

  return (
    <group ref={groupRef}>
      <points geometry={geom}>
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
    </group>
  );
}

export function SplatCloud({
  progressRef,
  orbit = true,
}: {
  progressRef: { current: number };
  orbit?: boolean;
}) {
  const [cloud, setCloud] = useState<BakedCloud | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadBakedCloud(CLOUD_URL)
      .then((c) => alive && setCloud(c))
      .catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, []);

  return (
    <Canvas
      camera={{ position: [0.5, -8.5, 3], up: [0, 0, -1], fov: 45 }}
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[dark.bg]} />
      {cloud && <CampusPoints cloud={cloud} progressRef={progressRef} orbit={orbit} />}
      {/* Mouse orbit + zoom (dev framing); the hand drives the model's rotation via heroOrbit. */}
      <OrbitControls makeDefault enablePan={false} enableZoom target={[0, 0, 0]} />
      <CamReporter />
      {error && null /* surfaced via console; HUD stays in the DOM layer */}
    </Canvas>
  );
}

/** Publishes the live camera position + target so the DOM can show / copy it (framing aid). */
export const camReadout = { pos: [0, 0, 0], target: [0, 0, 0], up: [0, 0, -1] };
function CamReporter() {
  const { camera, controls } = useThree();
  useFrame(() => {
    camReadout.pos = [camera.position.x, camera.position.y, camera.position.z];
    camReadout.up = [camera.up.x, camera.up.y, camera.up.z];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (controls as any)?.target;
    if (t) camReadout.target = [t.x, t.y, t.z];
  });
  return null;
}
