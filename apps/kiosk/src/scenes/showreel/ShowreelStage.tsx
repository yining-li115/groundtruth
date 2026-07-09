import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { dark } from "@groundtruth/tokens";
import { heroOrbit } from "../../lib/heroInput";
import {
  loadBakedCloud,
  buildCloudGeometry,
  makeSprite,
  POINT_VERT,
  POINT_FRAG,
  type BakedCloud,
} from "../../webgl/pointCloud";

/**
 * Idle-showreel point cloud on the RIGHT: the TUM Hauptgebäude as ~500k particles, semi-
 * transparent. It slowly auto-turns when idle; when a hand appears it hands off to
 * `heroOrbit` (drag to rotate, open palm = disperse, fist = reassemble — see
 * useHandHeadControl). `progressRef` morphs disperse↔assemble.
 */
const CLOUD_URL = "/splat/tum-campus.bin";
const POINT_SIZE = 0.075;
const ALPHA = 0.55; // semi-transparent backdrop
const IDLE_SPIN = 0.05; // radians / sec when no hand

function ShowreelPoints({
  cloud,
  progressRef,
}: {
  cloud: BakedCloud;
  progressRef: { current: number };
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const spin = useRef<THREE.Group>(null);
  const rot = useRef({ yaw: 0, pitch: 0 });
  const sprite = useMemo(makeSprite, []);
  const geom = useMemo(() => buildCloudGeometry(cloud), [cloud]);
  const uniforms = useMemo(
    () => ({
      uProgress: { value: 1 },
      uSize: { value: POINT_SIZE },
      uAlpha: { value: ALPHA },
      uMap: { value: sprite },
    }),
    [sprite],
  );

  useFrame((_, dt) => {
    const u = matRef.current?.uniforms.uProgress;
    if (u) u.value += ((progressRef.current ?? 1) - u.value) * 0.06;
    if (!spin.current) return;
    if (heroOrbit.touched) {
      // a hand is driving — ease to follow it
      rot.current.yaw += (heroOrbit.yaw - rot.current.yaw) * 0.1;
      rot.current.pitch += (heroOrbit.pitch - rot.current.pitch) * 0.1;
    } else {
      // idle: slow auto-spin, and keep heroOrbit synced so a hand can pick up seamlessly
      rot.current.yaw += IDLE_SPIN * Math.min(dt, 0.05);
      rot.current.pitch += (0 - rot.current.pitch) * 0.02;
      heroOrbit.yaw = rot.current.yaw;
      heroOrbit.pitch = rot.current.pitch;
    }
    spin.current.rotation.y = rot.current.yaw;
    spin.current.rotation.x = rot.current.pitch;
  });

  return (
    <group ref={spin}>
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

export function ShowreelStage({ progressRef }: { progressRef: { current: number } }) {
  const [cloud, setCloud] = useState<BakedCloud | null>(null);
  useEffect(() => {
    let alive = true;
    loadBakedCloud(CLOUD_URL).then((c) => alive && setCloud(c)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Canvas
      // distance sets the size (smaller number = larger cloud); tuned to fill nicely
      camera={{ position: [0.68, -12.2, 4.2], up: [0, 0, -1], fov: 42 }}
      onCreated={({ camera }) => {
        camera.up.set(0, 0, -1);
        camera.lookAt(0, 0, 0); // aim at the (centred) model, else it drifts off-frame
      }}
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      // wider canvas pushed further left so the cloud sits around screen-centre-right
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: "26%" }}
    >
      <color attach="background" args={[dark.bg]} />
      {cloud && <ShowreelPoints cloud={cloud} progressRef={progressRef} />}
    </Canvas>
  );
}
