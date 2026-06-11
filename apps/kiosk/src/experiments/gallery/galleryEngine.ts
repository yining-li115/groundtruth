/**
 * Horizontal parallax gallery engine — ported from the Codrops demo
 * (davidfaure/horizontal-parallax-gallery-codrops, MIT), kept close to the original so we
 * reuse its proven scroll + parallax math. Adapted for our app:
 *   - takes element refs instead of `document.querySelector`,
 *   - exposes `addScroll(delta)` so the kiosk can feed the phone's two-finger delta (the
 *     same signal that drives vertical page scroll today) — i.e. vertical finger input
 *     moves the gallery sideways. In dev, the mouse wheel feeds it.
 *
 * Mechanic: vertical wheel/finger delta → `scroll.target`; lerp-smoothed `scroll.current`;
 * the row is translated by `-current`; each image (125% wide in an overflow-hidden frame)
 * counter-shifts by its distance from the viewport centre → parallax depth.
 */

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (min: number, max: number, v: number) => Math.max(min, Math.min(max, v));

export class GalleryEngine {
  private container: HTMLElement;
  private wrapper: HTMLElement;
  private images: HTMLElement[];
  private scroll = { current: 0, target: 0, ease: 0.07, limit: 0 };
  private raf = 0;

  constructor(container: HTMLElement, wrapper: HTMLElement, images: HTMLElement[]) {
    this.container = container;
    this.wrapper = wrapper;
    this.images = images;

    this.onWheel = this.onWheel.bind(this);
    this.onResize = this.onResize.bind(this);
    this.render = this.render.bind(this);

    this.setLimit();
    window.addEventListener("wheel", this.onWheel, { passive: true });
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

  private onResize() {
    this.setLimit();
  }

  private applyParallax() {
    const center = window.innerWidth * 0.5;
    this.images.forEach((image) => {
      const parent = image.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const elementCenter = rect.left + rect.width * 0.5;
      // -1 (left) .. 0 (centre) .. 1 (right)
      const t = clamp(-1, 1, (elementCenter - center) / center);
      // image is 125% wide → translateX(%) is relative to that, safe max ~10%
      const shift = -t * 10; // counter-motion = parallax
      image.style.transform = `translate3d(${shift}%, 0, 0)`;
    });
  }

  private render() {
    this.scroll.target = clamp(0, this.scroll.limit, this.scroll.target);
    this.scroll.current = lerp(this.scroll.current, this.scroll.target, this.scroll.ease);

    const x = this.scroll.current < 0.01 ? 0 : -this.scroll.current;
    this.container.style.transform = `translateX(${x}px)`;
    this.applyParallax();

    this.raf = requestAnimationFrame(this.render);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("resize", this.onResize);
  }
}
