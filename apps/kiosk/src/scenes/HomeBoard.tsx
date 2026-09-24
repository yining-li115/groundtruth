import { useEffect, useRef, useState } from "react";
import { Logo } from "@groundtruth/ui";
import { ArrowRightIcon } from "../components/ArrowRightIcon";
import { activePointer } from "../lib/cursorPosition";
import { navigate } from "../lib/navigate";
import type { View } from "../state/store";
import "./homeBoard.css";

/**
 * The home page: one light ground carrying who this is, and one dark board carrying where to
 * go. (Previewable on its own at `/?exp=home2`, which is where it was designed.)
 *
 * It replaces the five colour bands. Those were built for the same problem — targets a hand
 * cannot miss, nothing to scroll to, no drawer to open first — and they solved it, but the
 * five destinations shouted as loudly as the group's own name and the wall read as a menu
 * rather than as a place. Here the two are separated: the left says what this group does, the
 * right is where a visitor goes, and only one of them is coloured.
 *
 * A row is still a full-width band a fifth of the column high, which is the point: it is the
 * largest target the layout can give an arm held up across a corridor, and its edges never
 * move, so the boundary under a resting cursor cannot shift beneath it (an earlier home grew
 * a band on hover, and the same pixel then opened different sections depending on which
 * direction it was approached from).
 *
 * Selection arrives as a block of colour behind the word rather than a highlight fading in —
 * a different kind of event, and the one that reads as the row being taken.
 *
 * The left side says three things and stops. A badge repeating the group's name above the
 * headline, a call-to-action and a row of three feature cards were all tried and all cut: the
 * page has exactly one thing to do, and anything on the left that looked like a second
 * control was competing for a pointer that is a whole arm in the air.
 *
 * The picture behind the type is used WHOLE — its own transparent margin is part of the
 * framing — and it is anchored to the bottom, stretched a little and flattened a little, so
 * the terrain reads as ground rather than as an object floating beside the words.
 */

const SECTIONS: { key: View; title: string; sub: string }[] = [
  { key: "research", title: "Research", sub: "Topics" },
  { key: "people", title: "People", sub: "The group" },
  { key: "projects", title: "Projects", sub: "Student work" },
  { key: "publications", title: "Publications", sub: "Papers" },
  { key: "teaching", title: "Teaching", sub: "Courses" },
];

/**
 * What the picture shows. Default: the terrain alone. `?shot=angle` puts the instrument back.
 *
 * The instrument and the terrain came out of the generator as ONE baked render, so their
 * relative sizes cannot be tuned in CSS — shrinking the instrument on the page shrinks the
 * terrain with it. `hero-terrain.webp` is a separate render of the terrain by itself (with a
 * real alpha channel), which is what lets the terrain be enlarged on its own.
 */
const SHOT =
  typeof window !== "undefined" && new URLSearchParams(location.search).get("shot") === "angle"
    ? "/home2/hero-angle.webp"
    : "/home2/hero-terrain.webp";

/**
 * Which row is lit on arrival. The first one: a board of five identical rows says nothing
 * about what selection looks like until one of them is selected, and a passer-by who has not
 * raised a hand yet has no other way to learn it.
 *
 * `?row=2` picks another one and `?row=-1` lights none, for looking at those states without a
 * pointer. (Reading the param needs the `has` check — `Number(null)` is 0, which silently
 * turned "no parameter" into "row 0" and made the two cases indistinguishable.)
 */
const INITIAL_ROW = (() => {
  if (typeof window === "undefined") return 0;
  const params = new URLSearchParams(location.search);
  if (!params.has("row")) return 0;
  const v = Number(params.get("row"));
  return Number.isInteger(v) && v >= 0 && v < SECTIONS.length ? v : -1;
})();

export function HomeBoard() {
  const [active, setActive] = useState(INITIAL_ROW);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Which row the pointer is over, decided by the SAME hit test the click goes through.
   *
   * Two earlier versions of this got it wrong. Reading the `.gt-hover` class the pointer
   * paints on is unsafe from React — React owns `className` on the rows and rewrites it on
   * every re-render, so lighting a row wiped the very class that said it was hovered (it
   * worked only for the row that was already lit, where no state changed). Caching the rows'
   * rectangles instead is unsafe for a different reason: a rectangle measured at mount can be
   * a fraction of a pixel off the live one, and then the row that LIGHTS and the row a pinch
   * OPENS disagree along a seam — the visitor pinches the highlighted row and the other one
   * opens. `elementFromPoint` is what the click itself uses, so the two cannot diverge.
   *
   * `activePointer` prefers a real mouse while one is moving, so one code path serves the
   * hand on the wall and a mouse in dev.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>(".hb-row")];
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const p = activePointer();
      if (!p) return;
      const row = document.elementFromPoint(p.x, p.y)?.closest(".hb-row");
      const i = row ? rows.indexOf(row as HTMLElement) : -1;
      // Only ever SET a selection here, never clear one: the hand cursor leaves a row the
      // moment it drifts, and a menu that unlights itself every time the hand wobbles reads
      // as the screen losing track of you.
      if (i >= 0) setActive((prev) => (prev === i ? prev : i));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="hb" ref={rootRef}>
      <section className="hb-left">
        {/* Behind the type, bounded by the panel, and never a target. */}
        <img
          className="hb-shot"
          data-shot={SHOT.includes("angle") ? "angle" : "terrain"}
          src={SHOT}
          alt=""
          aria-hidden
        />

        <header className="hb-brand">
          <div className="hb-brand__text">
            <b>Professorship of Photogrammetry and Remote Sensing</b>
            <span>TUM School of Engineering and Design</span>
            <span>Technical University of Munich</span>
          </div>
          <Logo variant="black" width="4.5rem" height="2.375rem" />
        </header>

        <div className="hb-copy">
          <h1 className="hb-headline">
            Making Machines
            <br />
            See and Think
            <br />
            <em>in 3D</em>
          </h1>

          <p className="hb-blurb">
            Photogrammetry and remote sensing at TUM — turning images, scans and satellites
            into measured, verified models of the real world.
          </p>
        </div>
      </section>

      {/* The dark board. Its own theme, so every colour in here is still a token. */}
      <nav className="hb-menu" data-theme="dark" aria-label="Sections">
        <div className="hb-menu__card">
          {SECTIONS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              data-hover
              className={`hb-row ${i === active ? "is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => navigate(s.key)}
            >
              <span className="hb-row__n">{String(i + 1).padStart(2, "0")}</span>
              <span className="hb-row__text">
                <span className="hb-row__t">{s.title}</span>
                <span className="hb-row__sub">{s.sub}</span>
              </span>
              <span className="hb-row__go" aria-hidden>
                <ArrowRightIcon />
              </span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
