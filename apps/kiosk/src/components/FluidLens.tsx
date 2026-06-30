import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
// html2canvas-pro (maintained fork) — supports oklch()/lab(), which Tailwind v4 emits and
// the original html2canvas 1.4.1 throws on. Same API.
import html2canvas from "html2canvas-pro";
import { activePointer } from "../lib/cursorPosition";
import "./fluidLens.css";

/**
 * FluidLens — a glass magnifier that follows the kiosk cursor and refracts the page beneath it.
 * Inspired by React Bits' FluidGlass (lens mode) but re-built for our stack (CLAUDE.md rule 9):
 * driven by OUR cursor (`activePointer`, so the phone-driven kiosk cursor or a dev mouse moves
 * it), and — since WebGL can't sample DOM — it refracts an html2canvas snapshot of the target.
 *
 * The glass is a custom screen-space shader (not MeshTransmissionMaterial, which rendered as an
 * opaque blob in this overlay): a circular region magnifies the snapshot toward the cursor, with
 * edge refraction, chromatic aberration and a soft glass rim; everything outside the disc is
 * discarded so the live DOM shows through. Snapshot re-taken on `contentKey` change + resize.
 * Mount only while a detail is open; skip under prefers-reduced-motion.
 */

export interface FluidLensProps {
  /** The element to snapshot and magnify (e.g. the detail panel). */
  targetRef: React.RefObject<HTMLElement | null>;
  /** Changes whenever the captured content changes → triggers a re-snapshot. */
  contentKey: string;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform vec2 uCursor;       // lens centre, uv (y up)
  uniform float uAspect;      // width / height
  uniform float uRadius;      // lens radius, fraction of height
  uniform float uZoom;        // magnification
  uniform float uAberration;  // chromatic split at the rim
  uniform float uHasTex;

  void main() {
    // Aspect-corrected vector from the cursor.
    vec2 d = vUv - uCursor;
    d.x *= uAspect;
    float dist = length(d);
    if (dist > uRadius) discard;

    float t = dist / uRadius;                 // 0 centre .. 1 edge
    vec2 dir = vUv - uCursor;

    // Fallback while/if no snapshot: a faint frosted glass disc so the lens is still visible.
    if (uHasTex < 0.5) {
      float rim = smoothstep(0.80, 1.0, t);
      float a = (1.0 - smoothstep(0.92, 1.0, t)) * 0.14 + rim * 0.10;
      gl_FragColor = vec4(vec3(1.0), a);
      return;
    }

    // Magnify toward the cursor, then bend outward near the rim (lens refraction).
    vec2 uvMag = uCursor + dir / uZoom;
    vec2 nrm = dir / max(length(dir), 1e-5);
    float bend = 0.045 * pow(t, 3.0);
    vec2 uv = uvMag + nrm * bend;

    // Chromatic aberration grows toward the rim.
    float ca = uAberration * t;
    vec3 col;
    col.r = texture2D(uTex, uv + nrm * ca).r;
    col.g = texture2D(uTex, uv).g;
    col.b = texture2D(uTex, uv - nrm * ca).b;

    // Glass: subtle rim highlight + a thin darker contour, soft alpha at the very edge.
    float rim = smoothstep(0.78, 1.0, t);
    col += rim * 0.12;
    col -= smoothstep(0.93, 1.0, t) * 0.10;
    float alpha = 1.0 - smoothstep(0.97, 1.0, t);

    gl_FragColor = vec4(col, alpha);
  }
`;

function LensPlane({ texture }: { texture: THREE.Texture | null }) {
  const { viewport, size } = useThree();
  const cursorUv = useRef(new THREE.Vector2(0.5, 0.5));

  const uniforms = useMemo(
    () => ({
      uTex: { value: null as THREE.Texture | null },
      uCursor: { value: new THREE.Vector2(0.5, 0.5) },
      uAspect: { value: 1 },
      uRadius: { value: 0.13 },
      uZoom: { value: 1.65 },
      uAberration: { value: 0.006 },
      uHasTex: { value: 0 },
    }),
    [],
  );

  useEffect(() => {
    uniforms.uTex.value = texture;
    uniforms.uHasTex.value = texture ? 1 : 0;
  }, [texture, uniforms]);

  useFrame(() => {
    uniforms.uAspect.value = size.width / size.height;

    const ptr = activePointer();
    if (ptr) {
      const tx = ptr.x / size.width;
      const ty = 1 - ptr.y / size.height; // screen y-down → uv y-up
      // Ease toward the cursor for a fluid feel.
      cursorUv.current.x += (tx - cursorUv.current.x) * 0.25;
      cursorUv.current.y += (ty - cursorUv.current.y) * 0.25;
    }
    uniforms.uCursor.value.copy(cursorUv.current);
  });

  return (
    <mesh scale={[viewport.width, viewport.height, 1]}>
      <planeGeometry />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

export function FluidLens({ targetRef, contentKey }: FluidLensProps) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const capture = async () => {
      const el = targetRef.current;
      if (!el) return;
      try {
        const snap = await html2canvas(el, {
          backgroundColor: "#000000",
          scale: Math.min(window.devicePixelRatio || 1, 2),
          logging: false,
          // Capture the settled look, not a mid-entrance (framer-motion) frame.
          onclone: (doc) => {
            const clone = doc.querySelector<HTMLElement>(".sp-detail");
            if (clone) {
              clone.style.opacity = "1";
              clone.style.transform = "none";
            }
          },
        });
        if (cancelled) return;
        const tex = new THREE.CanvasTexture(snap);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        setTexture((prev) => {
          prev?.dispose();
          return tex;
        });
      } catch (err) {
        // Snapshot failed (unsupported CSS, detached node) — keep the fallback glass disc.
        console.warn("[FluidLens] snapshot failed:", err);
      }
    };

    timer = window.setTimeout(capture, 90);

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(capture, 250);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }, [contentKey, targetRef]);

  useEffect(() => () => texture?.dispose(), [texture]);

  return (
    <div className="fluid-lens" aria-hidden="true">
      <Canvas dpr={[1, 1.5]} flat gl={{ alpha: true, antialias: true }}>
        <LensPlane texture={texture} />
      </Canvas>
    </div>
  );
}
