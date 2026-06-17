// @ts-nocheck — vendored port of Codrops depth-gallery (houmahani/codrops-depth-gallery, MIT).
// Stripped: no Stats/FPS, no tweakpane, no keydown debug, no Label/Trail render passes.
import * as THREE from "three";
import { Experience } from "./Experience";
import { Scroll } from "./Scroll";

class Engine {
  constructor(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Engine requires a valid canvas element");
    }

    this.canvas = canvas;
    // externalScroll: don't bind our own wheel/touch hijack; the host (home Open Topics
    // section) drives depth via setScrollProgress() from a scrubbed ScrollTrigger instead.
    this.externalScroll = Boolean(options.externalScroll);
    // overlayRoot: element the DOM label/intro overlays mount into (so they scope to the
    // canvas stage — fixed for the standalone exp, sticky for the home section). Defaults to body.
    this.overlayRoot = options.overlayRoot || null;
    this.experience = new Experience();
    this.debug = this.experience.debug;
    this.isInitialized = false;
    this.isRunning = false;
    this.isDisposed = false;
    this.animationFrameRequestId = null;
    this.preloadedTextures = new Map();
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 0, 6);

    this.scroll = new Scroll(this.camera, this.experience.gallery, this.debug);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    // Cap at 1.5, not full retina (2): the depth stack is scrubbed on scroll, where dpr 2
    // quadruples fragment work and stutters (matching the hero's dpr cap).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;

    this.onResize = () => this.resize();
    this.animate = this.update.bind(this);
  }

  async init() {
    if (this.isInitialized || this.isDisposed) return;

    this.preloadedTextures = await this.preloadTextures();
    if (this.isDisposed) return; // disposed while textures loaded (e.g. StrictMode remount)
    this.experience.gallery.setPreloadedTextures(this.preloadedTextures);

    await this.experience.init(this.scene, this.camera, this.overlayRoot);
    if (this.isDisposed) return;
    this.scroll.init();

    this.resize();
    window.addEventListener("resize", this.onResize);
    if (!this.externalScroll) this.scroll.bindEvents();

    this.isInitialized = true;
    this.start();
  }

  // Home integration: drive depth from a 0→1 scroll progress, and toggle the whole scene
  // (canvas + DOM label/intro overlays) so it only shows while the Open Topics section is active.
  setScrollProgress(progress) {
    this.scroll.setProgress(progress);
  }

  setVisible(visible) {
    this.canvas.style.visibility = visible ? "visible" : "hidden";
    this.experience.label?.setVisible(visible);
  }

  start() {
    if (!this.isInitialized || this.isRunning) return;
    this.isRunning = true;
    this.update();
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth || 1;
    const height = this.canvas.clientHeight || window.innerHeight || 1;
    if (width <= 0 || height <= 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.experience.gallery.updatePlaneScale();
    this.experience.gallery.layoutPlanes();
  }

  async preloadTextures() {
    const textureSources = this.experience.gallery.getTextureSources();
    if (!textureSources.length) return new Map();

    const textureLoader = new THREE.TextureLoader();
    const loadedTextures = new Map();

    await Promise.all(
      textureSources.map(async (textureSource) => {
        try {
          const texture = await textureLoader.loadAsync(textureSource);
          texture.colorSpace = THREE.SRGBColorSpace;
          loadedTextures.set(textureSource, texture);
        } catch (error) {
          console.warn(`Texture failed to load: ${textureSource}`, error);
        }
      })
    );

    return loadedTextures;
  }

  update() {
    if (!this.isRunning) return;

    this.animationFrameRequestId = requestAnimationFrame(this.animate);
    const time = performance.now();

    this.scroll.update();
    this.experience.update(time, this.camera, this.scroll);

    this.renderer.clear(true, true, true);
    this.experience.background.render(this.renderer);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.isRunning = false;
    this.isDisposed = true;

    if (this.animationFrameRequestId !== null) {
      cancelAnimationFrame(this.animationFrameRequestId);
      this.animationFrameRequestId = null;
    }

    window.removeEventListener("resize", this.onResize);
    this.scroll.dispose();

    this.preloadedTextures.forEach((texture) => texture.dispose());
    this.preloadedTextures.clear();
    this.experience.dispose?.();
    this.renderer.dispose();
  }
}

export { Engine };
