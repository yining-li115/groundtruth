import { useState } from "react";
import { SplatStage } from "../splatnav/SplatStage";
import { PuzzleRow, PUZZLE_NEWS } from "../puzzle/PuzzleAccordion";

/**
 * Combined idle showreel (experiment) — today's two pieces together: the real Gaussian-splat
 * campus as a right-biased, slowly-orbiting BACKDROP, with the puzzle news capsules floated over a
 * left scrim. Open-palm disperses the splat.
 *
 * The news AUTO-PLAYS by default (opens each case in turn) — this stands in for a cursor on the
 * touchless kiosk. A bottom-left switch flips to CURSOR CONTROL: while on, you click cases
 * yourself; off returns to auto-play. Candidate replacement for `scenes/Showreel.tsx`.
 *
 * Preview at /?exp=showreel2. Dark theme so the bright poster capsules pop over the campus.
 */
export function ShowreelSplit() {
  const [manual, setManual] = useState(false); // false = auto-play, true = cursor control

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      data-theme="dark"
      style={{ background: "var(--gt-bg)", color: "var(--gt-text-primary)", fontFamily: "var(--font-sans)" }}
    >
      {/* full-bleed splat backdrop so disperse fills the WHOLE screen; the campus is aimed
          off-centre-right by the camera (aimShift) rather than by clipping the canvas */}
      <SplatStage amp={120} aimShift={44} />

      {/* left scrim so the capsules and text read over the campus */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, var(--gt-bg) 0%, color-mix(in srgb, var(--gt-bg) 78%, transparent) 36%, color-mix(in srgb, var(--gt-bg) 20%, transparent) 60%, transparent 80%)",
        }}
      />

      {/* brand */}
      <div
        className="absolute left-[clamp(2rem,5vw,5rem)] top-[1.6rem] text-sm uppercase tracking-[0.14em]"
        style={{ color: "var(--gt-text-secondary)" }}
      >
        Photogrammetry &amp; Remote Sensing · TUM
      </div>

      {/* floated puzzle news, left + vertically centred; auto-plays unless cursor control is on */}
      <div className="absolute left-[clamp(2rem,5vw,5rem)] top-1/2 -translate-y-1/2">
        <PuzzleRow
          items={PUZZLE_NEWS}
          height="min(84vh, 640px)"
          collapsedW={92}
          activeW="min(84vh, 640px)"
          gap={18}
          radius={28}
          align="start"
          autoPlay={!manual}
        />
      </div>

      {/* bottom-left switch: cursor control on/off */}
      <div className="absolute bottom-[1.5rem] left-[clamp(2rem,5vw,5rem)] flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={manual}
          onClick={() => setManual((m) => !m)}
          className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none"
          style={{
            background: manual ? "var(--gt-accent)" : "color-mix(in srgb, var(--gt-text-secondary) 40%, transparent)",
            transition: "background 250ms ease",
            cursor: "pointer",
          }}
        >
          <span
            className="inline-block h-5 w-5 rounded-full"
            style={{
              background: "var(--gt-brand-white)",
              transform: manual ? "translateX(22px)" : "translateX(3px)",
              transition: "transform 250ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </button>
        <span className="text-sm" style={{ color: "var(--gt-text-secondary)" }}>
          {manual ? "Cursor control — click a case" : "Auto-playing · ✋ raise a hand to explode"}
        </span>
      </div>
    </div>
  );
}
