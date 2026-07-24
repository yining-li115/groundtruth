import { useEffect, useRef, useState } from "react";
import { activePointer } from "../../lib/cursorPosition";
import { BG } from "./assetColors";

/**
 * Cursor-grid experiment (/?exp=cursorgrid) — a glowing BALL OF LIGHT drifting behind a
 * REAL frosted-glass tile wall:
 * - the light is one vivid element (white-hot core → yellow → amber → ember penumbra)
 *   gliding behind the wall with heavy inertia;
 * - each pane is genuine frosted glass — `backdrop-filter: blur()` diffuses whatever
 *   light sits behind it (no faked gradients), plus cushion relief (edge vignette, top
 *   sheen, weighted bottom) so the panes read as thick glass pillows;
 * - the SEAMS between panes show the light RAW (unblurred) — the bright rims around
 *   lit tiles come for free, exactly like the reference.
 *
 * Cursor source is `activePointer` (real mouse in dev, the phone-driven kiosk cursor on
 * the wall) — the same plumbing the home cursor-fluid uses.
 */

const CELL = 118; // tile size (px)
const GAP = 8; // seam between panes — where the raw light leaks through
const LIGHT_R = 430; // light-field radius (px) — the ball spans a few panes
const BLUR = 26; // frosted-glass diffusion (px)
const EASE = 0.085; // light inertia — the slow drift behind the cursor IS the effect

export function CursorGridExperiment() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (reduced) return;
    const field = fieldRef.current;
    if (!field) return;

    let raf = 0;
    let cols = 0;
    let rows = 0;
    let cells: HTMLDivElement[] = [];
    let light: HTMLDivElement | null = null;
    let lit = new Set<number>();

    const build = () => {
      field.innerHTML = "";
      // the light ball — a REAL element behind the panes; panes blur it, seams leak it
      light = document.createElement("div");
      const size = LIGHT_R * 2;
      light.style.cssText =
        `position:absolute;left:0;top:0;width:${size}px;height:${size}px;` +
        `background:radial-gradient(circle,` +
        ` #fffdf2 0%, #ffd83a 15%, #f0a422 33%, #9c5f2c 54%,` +
        ` rgba(156,95,44,0.35) 68%, rgba(156,95,44,0) 80%);` +
        `will-change:transform;`;
      field.appendChild(light);

      cols = Math.ceil(window.innerWidth / CELL);
      rows = Math.ceil(window.innerHeight / CELL);
      const n = cols * rows;
      cells = new Array(n);
      lit = new Set<number>();
      for (let i = 0; i < n; i++) {
        const d = document.createElement("div");
        const x = (i % cols) * CELL;
        const y = Math.floor(i / cols) * CELL;
        const sheen = 0.35 + Math.random() * 0.25; // per-pane glass personality
        d.style.cssText =
          `position:absolute;left:${x + GAP / 2}px;top:${y + GAP / 2}px;` +
          `width:${CELL - GAP}px;height:${CELL - GAP}px;border-radius:28px;opacity:0;` +
          // the pane itself: barely-there milky film + cushion relief. The FROST comes
          // from backdrop-filter (toggled on only while the pane is near the light).
          `background:linear-gradient(rgba(255,255,255,0.09), rgba(250,248,244,0.03));` +
          `box-shadow:inset 0 2px 10px rgba(255,255,255,${sheen.toFixed(2)}),` +
          ` inset 0 -12px 26px rgba(70,45,20,0.30),` +
          ` inset 0 0 30px rgba(0,0,0,0.10);` +
          `will-change:opacity;`;
        field.appendChild(d);
        cells[i] = d;
      }
    };
    build();
    const onResize = () => build();
    window.addEventListener("resize", onResize);

    // the light's position — heavy inertia so it glides behind the cursor
    let lx = window.innerWidth / 2;
    let ly = window.innerHeight / 2;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const p = activePointer();
      if (p) {
        lx += (p.x - lx) * EASE;
        ly += (p.y - ly) * EASE;
      }
      if (light) {
        light.style.transform = `translate3d(${(lx - LIGHT_R).toFixed(1)}px,${(ly - LIGHT_R).toFixed(1)}px,0)`;
      }

      // panes within the light's reach become frosted glass; the rest stay invisible
      const span = Math.ceil(LIGHT_R / CELL) + 1;
      const bx = Math.floor(lx / CELL);
      const by = Math.floor(ly / CELL);
      const next = new Set<number>();

      for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
          const cx = bx + dx;
          const cy = by + dy;
          if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
          const i = cy * cols + cx;
          const tcx = cx * CELL + CELL / 2;
          const tcy = cy * CELL + CELL / 2;
          const s = Math.max(0, 1 - Math.hypot(tcx - lx, tcy - ly) / LIGHT_R);
          if (s <= 0.03) continue;
          next.add(i);
          const d = cells[i]!;
          d.style.opacity = String(Math.min(1, 0.1 + s * 1.5));
          if (!lit.has(i)) {
            // real frosted glass — only while lit (backdrop blur is expensive)
            d.style.backdropFilter = `blur(${BLUR}px) saturate(1.15)`;
          }
        }
      }

      for (const i of lit) {
        if (!next.has(i)) {
          const d = cells[i]!;
          d.style.opacity = "0";
          d.style.backdropFilter = "none";
        }
      }
      lit = next;
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      field.innerHTML = "";
    };
  }, [reduced]);

  return (
    <div
      className="relative min-h-screen overflow-hidden"
      style={{ background: BG }}
    >
      {/* the frosted tile wall — behind the copy, above the backdrop */}
      <div ref={fieldRef} className="pointer-events-none absolute inset-0" />

      {/* minimal dressing so there's something to sweep the cursor across */}
      <div className="pointer-events-none absolute left-[16vw] top-[22vh] text-4xl font-bold text-white">
        R
      </div>
      <p
        className="pointer-events-none absolute right-[12vw] top-[74vh] w-[22rem] text-xs leading-relaxed"
        style={{ color: "rgba(255,255,255,0.85)" }}
      >
        We believe in enabling true ownership of digital content, fostering a sustainable
        ecosystem where creators can thrive and connect with their audiences in
        innovative ways.
      </p>
    </div>
  );
}
