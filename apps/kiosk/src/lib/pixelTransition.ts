import { gsap } from "gsap";
import { prefersReducedMotion } from "./scroll";

/**
 * Pixel page transition — reimplemented from Codrops' PixelTransition (demo 4, MIT). A fixed
 * full-screen grid of cells scales/fades IN (covering the screen, scattered across the grid),
 * the view is swapped behind the cover, then the cells scale/fade OUT to reveal the new page.
 * Cells + grid size are registered by <PixelOverlay/>; navigation calls runPixelTransition().
 */
let cells: HTMLElement[] = [];
let grid: [number, number] = [9, 17];

export function registerPixelCells(els: HTMLElement[], rows: number, cols: number) {
  cells = els;
  grid = [rows, cols];
}

const overlayEl = () => cells[0]?.parentElement ?? null;

function show(): Promise<void> {
  return new Promise((resolve) => {
    const el = overlayEl();
    if (!el) return resolve();
    gsap.set(el, { opacity: 1 });
    gsap.fromTo(
      cells,
      { scale: 0, opacity: 0 },
      {
        scale: 1.03, // slight overlap so the cover is seamless
        opacity: 1,
        duration: 0.35,
        ease: "power2.out",
        stagger: { grid, from: "random", amount: 0.3 },
        onComplete: () => resolve(),
      },
    );
  });
}

function hide(): Promise<void> {
  return new Promise((resolve) => {
    const el = overlayEl();
    if (!el) return resolve();
    gsap.to(cells, {
      scale: 0,
      opacity: 0,
      duration: 0.35,
      ease: "power2.in",
      stagger: { grid, from: "random", amount: 0.3 },
      onComplete: () => {
        gsap.set(el, { opacity: 0 });
        resolve();
      },
    });
  });
}

let animating = false;

/** Cover the screen, run `swap` (the view change) behind it, then reveal. */
export async function runPixelTransition(swap: () => void) {
  if (prefersReducedMotion || !cells.length || animating) {
    swap();
    return;
  }
  animating = true;
  await show();
  swap();
  await new Promise((r) => setTimeout(r, 80)); // let the new view paint behind the cover
  await hide();
  animating = false;
}
