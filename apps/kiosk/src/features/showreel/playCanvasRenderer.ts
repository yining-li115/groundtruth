import { createViewer, type ViewerHandle } from "@playcanvas/supersplat-viewer/viewer";
import { defaultSettings } from "@playcanvas/supersplat-viewer/settings";
import "@playcanvas/supersplat-viewer/viewer.css";
import type { Entity } from "playcanvas";
import * as THREE from "three";

/**
 * The production showreel keeps all camera ownership in the existing Three-based navigation
 * controller. PlayCanvas is deliberately only a renderer: this adapter mirrors the final
 * virtual-camera pose into the official SuperSplat viewer immediately before every frame.
 *
 * The source SOG and Spark use different runtime basis fixes. Spark's scene used Rx(180deg),
 * while the official viewer applies Rz(180deg); their world frames therefore differ by
 * Ry(180deg). Applying that one rigid transform to both position and orientation preserves
 * every authored stop, collision decision and hand-driven movement exactly.
 */
export type PlayCanvasCampusRenderer = {
  readonly canvas: HTMLCanvasElement;
  readonly viewer: ViewerHandle;
  readonly loaded: Promise<void>;
  syncCamera(camera: THREE.PerspectiveCamera): void;
  requestFrame(): void;
  dispose(): void;
};

type CreatePlayCanvasCampusRendererOptions = {
  host: HTMLElement;
  contentUrl: string;
  budgetMillions: number;
  interactiveCanvas: boolean;
  onProgress?: (progress: number) => void;
};

const BASIS_TURN = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI,
);

export async function createPlayCanvasCampusRenderer({
  host,
  contentUrl,
  budgetMillions,
  interactiveCanvas,
  onProgress,
}: CreatePlayCanvasCampusRendererOptions): Promise<PlayCanvasCampusRenderer> {
  const settings = defaultSettings("environment");
  settings.tonemapping = "none";
  settings.highPrecisionRendering = true;
  settings.background.color = [0, 0, 0];
  settings.postEffectSettings.sharpness.enabled = false;
  settings.cameras[0] = {
    initial: {
      position: [0, 0, 0],
      target: [0, 0, -1],
      fov: 60,
    },
  };

  const viewer = await createViewer({
    container: host,
    settings,
    contentUrl,
    renderer: "webgpu",
    ui: false,
    noanim: true,
    nofx: true,
    hpr: true,
    budget: budgetMillions,
  });

  viewer.state.inputEnabled = false;
  viewer.state.performanceMode = false;

  // The host may already contain the preserved Three sky canvas. Select only the canvas the
  // Viewer owns; a generic `querySelector("canvas")` would bind controls and lifecycle events
  // to the sky instead of the Gaussian renderer.
  const canvas = host.querySelector(".sse-viewer > canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    viewer.destroy();
    throw new Error("SuperSplat viewer did not create a canvas");
  }
  canvas.style.pointerEvents = interactiveCanvas ? "auto" : "none";

  const cameraEntity = viewer.app.root.findByName("camera") as Entity | null;
  const cameraComponent = cameraEntity?.camera;
  if (!cameraEntity || !cameraComponent) {
    viewer.destroy();
    throw new Error("SuperSplat viewer camera is unavailable");
  }

  // The existing analytic sky remains a separate Three layer behind this canvas. Keep the
  // model backbuffer transparent so switching the Gaussian renderer cannot replace that sky
  // with the viewer's black clear colour. PlayCanvas creates its WebGPU/WebGL context with
  // alpha enabled; only the camera clear alpha needs overriding here.
  cameraComponent.clearColor.set(0, 0, 0, 0);

  const transformedRotation = new THREE.Quaternion();
  const syncCamera = (camera: THREE.PerspectiveCamera) => {
    transformedRotation.copy(BASIS_TURN).multiply(camera.quaternion).normalize();
    cameraEntity.setPosition(-camera.position.x, camera.position.y, -camera.position.z);
    cameraEntity.setRotation(
      transformedRotation.x,
      transformedRotation.y,
      transformedRotation.z,
      transformedRotation.w,
    );
    // Existing waypoints were authored with Three's vertical FOV. The viewer defaults to a
    // horizontal FOV on landscape displays, which would silently change every composed shot.
    cameraComponent.horizontalFov = false;
    cameraComponent.fov = camera.fov;
  };

  // The viewer controller updates earlier in the frame. Reassert the externally-owned pose at
  // prerender so pointer/keyboard state inside the headless viewer can never steal the camera.
  let currentCamera: THREE.PerspectiveCamera | null = null;
  viewer.app.on("prerender", () => {
    const camera = currentCamera;
    if (camera) syncCamera(camera);
  });

  const loaded = new Promise<void>((resolve, reject) => {
    if (viewer.state.loaded) {
      resolve();
      return;
    }
    const onLoaded = () => {
      viewer.events.off("loaded:changed", onLoaded);
      viewer.events.off("progress:changed", onProgressChanged);
      resolve();
    };
    const onProgressChanged = (value: number) => onProgress?.(value);
    viewer.events.on("loaded:changed", onLoaded);
    viewer.events.on("progress:changed", onProgressChanged);

    // Loading failures are reported by the underlying asset registry rather than ViewerState.
    viewer.app.assets.on("error", (error: unknown) => {
      viewer.events.off("loaded:changed", onLoaded);
      viewer.events.off("progress:changed", onProgressChanged);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  return {
    canvas,
    viewer,
    loaded,
    syncCamera(camera) {
      currentCamera = camera;
      syncCamera(camera);
    },
    requestFrame() {
      viewer.app.renderNextFrame = true;
    },
    dispose() {
      currentCamera = null;
      viewer.destroy();
    },
  };
}
