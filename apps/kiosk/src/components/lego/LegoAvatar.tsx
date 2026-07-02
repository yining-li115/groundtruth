import { Suspense, useMemo, useRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { legoVertex, legoFragment } from "./legoShader";
import { activePointer } from "../../lib/cursorPosition";
import "./legoAvatar.css";

/**
 * LegoAvatar — renders any photo as the LEGO-pixellation effect (ported from
 * rock-biter/lego-pixellation; see legoShader.ts). Reusable: drop it in a People card, the
 * upload lab, or the standalone experiment. Moving the cursor over it melts the bricks back
 * into the real photo (when `interactive`).
 *
 * IMPORTANT (R3F gotcha): live `subdivision` changes are pushed through a ref created HERE,
 * outside the <Canvas>. R3F does not re-render Canvas children when this DOM component
 * re-renders, so a ref created *inside* the plane would never see prop updates — only the
 * initial value would apply. The ref's identity is stable; the frame loop reads `.current`.
 */

function LegoPlane({
  src,
  subRef,
  interactive,
}: {
  src: string;
  subRef: MutableRefObject<number>;
  interactive: boolean;
}) {
  const tex = useLoader(THREE.TextureLoader, src);
  const tmp = useMemo(() => new THREE.Vector2(0.5, 0.5), []);

  useMemo(() => {
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.NoColorSpace; // gamma-space round-trip (see shader note)
    tex.needsUpdate = true;
  }, [tex]);

  const uniforms = useMemo(
    () => ({
      uAvatarTexture: { value: tex },
      uSubdivision: { value: subRef.current },
      uLightAngle: { value: (Math.PI * 3) / 4 },
      uTime: { value: 0 },
      uCursor: { value: new THREE.Vector2(0.5, 0.5) },
      uCursorOn: { value: 0 },
      uCursorRadius: { value: 0.16 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tex],
  );

  useFrame((state, dt) => {
    uniforms.uSubdivision.value = subRef.current; // live brick count (ref read every frame)
    uniforms.uTime.value += dt;

    if (!interactive) {
      uniforms.uCursorOn.value = 0;
      return;
    }
    const ptr = activePointer();
    const rect = state.gl.domElement.getBoundingClientRect();
    let on = 0;
    if (ptr && rect.width > 0) {
      const x = (ptr.x - rect.left) / rect.width;
      const y = 1 - (ptr.y - rect.top) / rect.height;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        tmp.set(x, y);
        uniforms.uCursor.value.lerp(tmp, 0.25);
        on = 1;
      }
    }
    uniforms.uCursorOn.value += (on - uniforms.uCursorOn.value) * 0.15;
  });

  return (
    // frustumCulled off: the vertex shader places this quad straight in clip space.
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        vertexShader={legoVertex}
        fragmentShader={legoFragment}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

export interface LegoAvatarProps {
  /** Image URL (same-origin or CORS-enabled, or an object URL from an upload). */
  src: string;
  /** Static brick count per side (for fixed avatars, e.g. People cards). */
  subdivision?: number;
  /** LIVE brick count: a ref the caller mutates directly (slider/wheel). When provided it
   *  overrides `subdivision` and is read every frame — no React re-render needed, so the
   *  value reaches the shader even though R3F doesn't reliably re-render Canvas children. */
  subRef?: MutableRefObject<number>;
  /** Cursor-melt back to the real photo. Default true. */
  interactive?: boolean;
  /** Device pixel ratio cap (keep 1 — the fragment shader is heavy). */
  dpr?: number;
  /** Keep the drawing buffer so the canvas can be exported via toDataURL (the lab uses this). */
  preserveBuffer?: boolean;
  className?: string;
}

export function LegoAvatar({
  src,
  subdivision = 28,
  subRef,
  interactive = true,
  dpr = 1,
  preserveBuffer = false,
  className,
}: LegoAvatarProps) {
  // For the static case, keep an internal ref in sync with the prop. A caller-supplied
  // subRef (live slider/wheel) takes over and is mutated directly by the caller.
  const internalRef = useRef(subdivision);
  internalRef.current = subdivision;
  const liveRef = subRef ?? internalRef;

  return (
    <div className={"lego-av" + (className ? " " + className : "")}>
      <Canvas
        dpr={dpr}
        flat
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          preserveDrawingBuffer: preserveBuffer,
        }}
      >
        {/* Suspense INSIDE the Canvas: useLoader suspends while the texture loads; without
            this it bubbles up and unmounts the Canvas → WebGL "Context Lost" + flash. */}
        <Suspense fallback={null}>
          <LegoPlane src={src} subRef={liveRef} interactive={interactive} />
        </Suspense>
      </Canvas>
    </div>
  );
}
