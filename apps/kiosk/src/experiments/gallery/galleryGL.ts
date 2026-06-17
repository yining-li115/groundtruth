import * as THREE from "three";

/**
 * WebGL horizontal parallax gallery — ported from the Codrops demo's WebGL version
 * (davidfaure/horizontal-parallax-gallery-codrops, MIT), kept close to the original.
 * Invisible DOM <img> placeholders define the layout/bounds; one three.js plane per image
 * is positioned at its element's pixel bounds (camera is px-mapped: 1 world unit = 1px,
 * camera z = 100). Scrolling slides the planes; the smooth "image change" is a uv.x shift
 * in the fragment shader (distance-from-centre parallax) — sharper/smoother than the CSS
 * translate version. lil-gui (debug) and vite-plugin-glsl are dropped; GLSL is inlined.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec2 uResolution;       // plane size in px
  uniform vec2 uImageResolution;
  uniform float uParallax;
  uniform float uUvScale;
  uniform float uShaderMultiplier;
  uniform float uRadius;          // on-screen corner radius in px

  vec2 coverUv(vec2 uv, vec2 resolution, vec2 imageResolution) {
    vec2 ratio = vec2(
      min((resolution.x / resolution.y) / (imageResolution.x / imageResolution.y), 1.0),
      min((resolution.y / resolution.x) / (imageResolution.y / imageResolution.x), 1.0)
    );
    return vec2(
      uv.x * ratio.x + (1.0 - ratio.x) * 0.5,
      uv.y * ratio.y + (1.0 - ratio.y) * 0.5
    );
  }

  void main() {
    vec2 uv = coverUv(vUv, uResolution, uImageResolution);
    uv.x += uParallax * uShaderMultiplier;   // horizontal parallax
    uv -= 0.5;
    uv *= uUvScale;                          // zoom out a touch to give parallax room
    uv += 0.5;
    vec3 col = texture2D(uTexture, uv).rgb;

    // Rounded-rectangle alpha (SDF in plane px space).
    vec2 halfSize = uResolution * 0.5;
    vec2 pp = (vUv - 0.5) * uResolution;
    vec2 q = abs(pp) - (halfSize - uRadius);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    float alpha = 1.0 - smoothstep(-1.0, 1.0, d);

    gl_FragColor = vec4(col, alpha);
  }
`;

interface Sizes {
  width: number;
  height: number;
}

interface MediaUniforms {
  uTexture: { value: THREE.Texture | null };
  uResolution: { value: THREE.Vector2 };
  uImageResolution: { value: THREE.Vector2 };
  uParallax: { value: number };
  uUvScale: { value: number };
  uShaderMultiplier: { value: number };
  uRadius: { value: number };
}

class GLMedia {
  element: HTMLElement;
  viewport: Sizes;
  geometry: THREE.PlaneGeometry;
  material: THREE.ShaderMaterial;
  uniforms: MediaUniforms;
  mesh: THREE.Mesh;
  bounds: DOMRect;
  parallaxIntensity = 0.8;

  constructor(scene: THREE.Group, element: HTMLElement, viewport: Sizes, geometry: THREE.PlaneGeometry) {
    this.element = element;
    this.viewport = viewport;
    this.geometry = geometry;
    this.bounds = element.getBoundingClientRect();

    this.uniforms = {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(this.bounds.width || 1, this.bounds.height || 1) },
      uImageResolution: { value: new THREE.Vector2(1, 1) },
      uParallax: { value: 0 },
      uUvScale: { value: 0.74 }, // more zoom-in headroom so the stronger parallax shift never reveals edges
      uShaderMultiplier: { value: 1.0 },
      uRadius: { value: 22 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as { [uniform: string]: THREE.IUniform },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    scene.add(this.mesh);

    const tex = new THREE.TextureLoader().load(element.getAttribute("src") as string, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      if (t.image) this.uniforms.uImageResolution.value.set(t.image.width, t.image.height);
    });
    this.uniforms.uTexture.value = tex;
    this.updateScale();
  }

  updateScale() {
    this.bounds = this.element.getBoundingClientRect();
    this.mesh.scale.set(this.bounds.width, this.bounds.height, 1);
    this.uniforms.uResolution.value.set(this.bounds.width, this.bounds.height);
  }

  updatePosition() {
    // bounds are the LIVE on-screen rect of the placeholder (the DOM row is translated by
    // the scroll), so the plane sits exactly on its placeholder — no extra scroll offset.
    this.mesh.position.x = this.bounds.left - this.viewport.width / 2 + this.bounds.width / 2;
    this.mesh.position.y = -this.bounds.top + this.viewport.height / 2 - this.bounds.height / 2;
  }

  updateParallax() {
    const elementLeft = this.bounds.left;
    const elementRight = elementLeft + this.bounds.width;
    if (elementRight >= 0 && elementLeft <= window.innerWidth) {
      const elementCenter = elementLeft + this.bounds.width / 2;
      const distance = (elementCenter - window.innerWidth / 2) / window.innerWidth;
      this.uniforms.uParallax.value = distance * this.parallaxIntensity;
    }
  }

  render() {
    // Live bounds: the placeholder moves (the row is translated by scroll, and it may move
    // vertically when the home section is pinned), so re-read each frame.
    this.bounds = this.element.getBoundingClientRect();
    this.updateParallax();
    this.updatePosition();
  }

  onResize(viewport: Sizes) {
    this.viewport = viewport;
    this.updateScale();
  }
}

export class GalleryGL {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private group = new THREE.Group();
  private camera: THREE.PerspectiveCamera;
  private medias: GLMedia[];
  private screen: Sizes;
  private container: HTMLElement;
  private wrapper: HTMLElement;
  private scroll = { current: 0, target: 0, ease: 0.07, limit: 0 };
  private raf = 0;
  private selfWheel = true;

  constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    wrapper: HTMLElement,
    elements: HTMLElement[],
    selfWheel = true,
  ) {
    this.container = container;
    this.wrapper = wrapper;
    this.selfWheel = selfWheel;
    this.screen = { width: window.innerWidth, height: window.innerHeight };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // Cap at 1.5, not full retina (2): this gallery is scrubbed on scroll, and dpr 2
    // quadruples fragment work → stutter under fast scrolling (same call the hero made).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(this.screen.width, this.screen.height);

    // Perspective camera mapped so 1 world unit = 1px at z = 0 (plane sits there).
    const fov = 2 * Math.atan(this.screen.height / 2 / 100) * (180 / Math.PI);
    this.camera = new THREE.PerspectiveCamera(fov, this.screen.width / this.screen.height, 0.01, 1000);
    this.camera.position.set(0, 0, 100);
    this.scene.add(this.group);

    const geometry = new THREE.PlaneGeometry(1, 1, 32, 32);
    this.medias = elements.map((el) => new GLMedia(this.group, el, this.screen, geometry));

    this.setLimit();
    this.onWheel = this.onWheel.bind(this);
    this.onResize = this.onResize.bind(this);
    this.render = this.render.bind(this);
    if (this.selfWheel) window.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("resize", this.onResize);
    this.render();
  }

  private setLimit() {
    this.scroll.limit = this.container.scrollWidth - this.wrapper.clientWidth;
  }

  private onWheel(e: WheelEvent) {
    this.scroll.target += e.deltaY;
  }

  /** Feed an external scroll delta (kiosk: the phone's two-finger `dy`). */
  addScroll(delta: number) {
    this.scroll.target += delta;
  }

  /** Total horizontal scroll range (px). Used to map a pinned section's progress → scroll. */
  getLimit(): number {
    this.setLimit();
    return this.scroll.limit;
  }

  /** Set the horizontal scroll target directly (home: driven by ScrollTrigger progress). */
  setTarget(px: number) {
    this.scroll.target = px;
  }

  private onResize() {
    this.screen = { width: window.innerWidth, height: window.innerHeight };
    this.camera.aspect = this.screen.width / this.screen.height;
    this.camera.fov = 2 * Math.atan(this.screen.height / 2 / 100) * (180 / Math.PI);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.screen.width, this.screen.height);
    // Cap at 1.5, not full retina (2): this gallery is scrubbed on scroll, and dpr 2
    // quadruples fragment work → stutter under fast scrolling (same call the hero made).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.setLimit();
    this.medias.forEach((m) => m.onResize(this.screen));
  }

  private render() {
    this.scroll.target = Math.max(0, Math.min(this.scroll.limit, this.scroll.target));
    // Self-driven (wheel): lerp for smoothing. Externally driven (home ScrollTrigger): the
    // scrub + Lenis already smooth, so track the target 1:1 to avoid double-lag.
    this.scroll.current = this.selfWheel
      ? this.scroll.current + (this.scroll.target - this.scroll.current) * this.scroll.ease
      : this.scroll.target;
    // Translate the DOM row by the scroll so its (invisible-image) figures — and the Sadie
    // captions inside them — track the WebGL planes exactly.
    this.container.style.transform = `translateX(${-this.scroll.current}px)`;
    this.medias.forEach((m) => m.render());
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.render);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
  }
}
