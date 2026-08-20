import { Logo } from "@groundtruth/ui";
import { navigate } from "../lib/navigate";
import { useKioskStore } from "../state/store";
import { SECTION_COLOR, SECTION_ORDER } from "./sectionColors";
import "./homeMenu.css";

/**
 * The home page, as the menu.
 *
 * The old home was a scroll: a WebGL hero that dispersed as you went down, then a spotlight
 * gallery, then a news grid, and the way into a section was a button in a drawer behind a
 * MENU toggle. That is a mouse-and-scroll shape. Driven by a hand from across a corridor it
 * asks for two things this pointer is worst at — a long scroll to reach anything, and a small
 * control to open before any destination even exists.
 *
 * So the destinations ARE the page. Five full-height columns, one per section, each an
 * enormous target that cannot be missed, sitting next to the one sentence the group wants a
 * passer-by to read. Nothing to scroll to, nothing to open first.
 *
 * The columns carry the same colours the MENU button sweeps when it opens (`sectionColors`),
 * so the two read as the same object seen twice: the sweep is a preview of where each colour
 * goes, and the home page is where they came to rest.
 *
 * Layout follows the reference the supervisor picked: slogan on the left, colour columns
 * standing on the right, each labelled along its own length with an arrow at the foot.
 * Re-implemented from tokens and our own components rather than pasted (CLAUDE.md rule 9).
 */

const LABEL: Record<(typeof SECTION_ORDER)[number], { title: string; sub: string }> = {
  teaching: { title: "Teaching", sub: "Courses" },
  research: { title: "Research", sub: "Topics" },
  projects: { title: "Projects", sub: "Student work" },
  publications: { title: "Publications", sub: "Papers" },
  people: { title: "People", sub: "The group" },
};

export function HomeMenu() {
  const handPresent = useKioskStore((s) => s.handPresent);

  return (
    <div className="hm">
      {/* No MENU toggle here. This page IS the menu — a drawer that opens to reveal the same
          five destinations already standing on screen is a second door into the room you are
          in, and it was landing on top of the last column's number. The sections keep it. */}
      <div className="hm__left">
        <div className="hm__brand">
          <div className="hm__brand-text">
            <span className="hm__brand-strong">
              Professorship of Photogrammetry and Remote Sensing
            </span>
            <span>TUM School of Engineering and Design</span>
            <span>Technical University of Munich</span>
          </div>
          <Logo variant="black" width={86} height={45} />
        </div>

        <h1 className="hm__slogan">
          Making Machines
          <br />
          See and Think in 3D
        </h1>

        <p className="hm__blurb">
          Photogrammetry and remote sensing at TUM — turning images, scans and satellites into
          measured, verified models of the real world.
        </p>

        <p className={`hm__hint ${handPresent ? "is-on" : ""}`}>
          Point at a band · make a fist (or pinch) to open
        </p>
      </div>

      <nav className="hm__cols" aria-label="Sections">
        {SECTION_ORDER.map((key, i) => {
          const c = SECTION_COLOR[key];
          const l = LABEL[key];
          return (
            <button
              key={key}
              type="button"
              className="hm__col"
              style={{ background: c.bg, color: c.fg }}
              onClick={() => navigate(key)}
              aria-label={l.title}
            >
              <span className="hm__num">{String(i + 1).padStart(2, "0")}</span>
              <span className="hm__text">
                <span className="hm__label">{l.title}</span>
                <span className="hm__sub">{l.sub}</span>
              </span>
              <span className="hm__arrow" aria-hidden>
                →
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
