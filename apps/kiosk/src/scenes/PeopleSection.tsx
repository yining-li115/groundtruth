import { useEffect, useRef, useState } from "react";
import type { Person } from "../../../../content/schema";
import { people } from "../lib/content";
import { SectionHome } from "../components/SectionHome";
import { LegoAvatarLab } from "../components/lego/LegoAvatarLab";
import { PersonDetail } from "../experiments/people/PersonDetail";
import { activePointer } from "../lib/cursorPosition";
import { scrollToTop, scrollToY } from "../lib/scroll";
import "./people.css";

/**
 * People — the group roster. Content is data (content/people.json, CLAUDE.md rule 3): each
 * member carries a `category`, and we group by it in a fixed order, so adding a person is a
 * JSON edit that lands in the right group automatically. Layout mirrors the design locked in
 * the ?exp=people prototype: a sticky "TEAM" intro beside a grid of portrait cards, with a
 * cursor-proximity scale "lens" driven by the kiosk cursor (works for the hand pointer
 * on the wall and a real mouse in dev — see lib/cursorPosition).
 */

// Display order for the known groups; any unlisted category is appended after these.
const CATEGORY_ORDER = [
  "Director",
  "Secretary",
  "Research Associates",
  "Guests (Externals, Scholarships)",
  "Student Assistants",
  "Associate Lecturers",
  "Alumni",
];

const AVATAR_STYLE = "personas"; // unified placeholder-avatar style (see docs/design-system asset note)

// TRYING real cut-out photos on the roster thumbnails (previously cartoon-only). Cut-outs are
// the transparent-background PNGs under content/media/people/<id>.png, bundled by Vite.
// To revert: return the DiceBear URL unconditionally in avatarUrl().
const cutouts = import.meta.glob<string>("../../../../content/media/people/*.png", {
  eager: true,
  import: "default",
});
const cutoutUrl = (id: string): string | undefined =>
  Object.entries(cutouts).find(([path]) => path.endsWith(`/${id}.png`))?.[1]; // 15 real cut-outs

/** A member's card image: their real cut-out photo if we have one, else a generated cartoon. */
function avatarUrl(p: Person): string {
  const cut = cutoutUrl(p.id);
  if (cut) return cut;
  return `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(
    `${p.firstName} ${p.lastName}`,
  )}&backgroundColor=transparent`;
}

function groupByCategory(list: Person[]): { label: string; people: Person[] }[] {
  const byCat = new Map<string, Person[]>();
  for (const p of list) {
    const arr = byCat.get(p.category) ?? [];
    arr.push(p);
    byCat.set(p.category, arr);
  }
  const ordered = CATEGORY_ORDER.filter((c) => byCat.has(c));
  const extras = [...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c));
  return [...ordered, ...extras].map((label) => ({ label, people: byCat.get(label)! }));
}

/** Cursor-proximity scale: each item grows by how close the kiosk cursor is (a soft lens).
 *  Driven by activePointer() in a rAF loop so it follows the camera-driven cursor on the wall
 *  and a real mouse in dev alike. Reduced motion opts out. */
function useProximityScale(rootRef: React.RefObject<HTMLDivElement | null>, key: unknown) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const items = [...root.querySelectorAll<HTMLElement>(".ppl-card, .ppl-group__label, .ppl__title")];
    if (!items.length) return;
    const scales = new Array(items.length).fill(1);
    const RADIUS = 220;
    // 1.6 grew a 271px card to 433px — 81px past each edge, into a 33px gutter — so cards
    // slid under a cursor that had not moved, and a pinch opened whichever neighbour had
    // arrived. Measured: parked at one card, pinched, opened a different person. The lens is
    // worth having, but not at the price of the target moving out from under the aim, so it
    // now grows only within the space between cards.
    const MAX_SCALE = 1.12;
    const EASE = 0.18;

    let raf = 0;
    const tick = () => {
      const ptr = activePointer();
      const rects = items.map((el) => el.getBoundingClientRect());
      for (let i = 0; i < items.length; i++) {
        const r = rects[i]!;
        let p = 0;
        if (ptr) {
          const d = Math.hypot(ptr.x - (r.left + r.width / 2), ptr.y - (r.top + r.height / 2));
          p = Math.max(0, Math.min(1, 1 - d / RADIUS));
        }
        const target = 1 + (MAX_SCALE - 1) * p;
        scales[i] += (target - scales[i]) * EASE;
        const s = scales[i];
        const el = items[i]!;
        el.style.transform = `scale(${s.toFixed(4)})`;
        if (el.classList.contains("ppl-card")) {
          el.style.zIndex = s > 1.02 ? String(Math.round((s - 1) * 100)) : "";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      items.forEach((el) => {
        el.style.transform = "";
        el.style.zIndex = "";
      });
    };
    // `key` is what makes this re-run. The dependency used to be the ref alone, which never
    // changes — so after a profile opened and the roster unmounted, the loop went on measuring
    // and transforming the OLD, detached cards forever, and the lens was dead for the rest of
    // the session while a rAF loop kept calling getBoundingClientRect on nothing.
  }, [rootRef, key]);
}

export function PeopleSection() {
  const pageRef = useRef<HTMLDivElement>(null);
  // TEST entry (remove once real portraits land): try the LEGO avatar effect on an uploaded photo.
  const [legoLab, setLegoLab] = useState(false);
  // Which member's detail page is open (null = roster).
  const [selected, setSelected] = useState<Person | null>(null);
  useProximityScale(pageRef, selected);

  const groups = groupByCategory(people);

  // A profile is a new screen even though it does not go through `navigate`, so it opens at
  // its own top — otherwise it inherits the roster's scroll, and since it is taller than the
  // viewport it clamps to its own bottom with Back above the top edge, reachable by nothing.
  // Measured: eight profiles, eight failures.
  //
  // Coming BACK is the opposite case and wants the opposite thing: returning someone to the
  // top of a long roster they had scrolled halfway down loses their place, so the position is
  // put back exactly as they left it.
  const rosterScroll = useRef(0);
  useEffect(() => {
    if (selected) {
      rosterScroll.current = window.scrollY;
      scrollToTop();
    } else if (rosterScroll.current > 0) {
      scrollToY(rosterScroll.current);
    }
  }, [selected]);

  if (selected) return <PersonDetail person={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="ppl" ref={pageRef} style={{ color: "var(--gt-text-primary)" }}>
      {/* Dev/test entry — opens the LEGO avatar lab (upload a photo, preview, save PNG).
          It remains bottom-right, opposite the persistent bottom-left Home target, and stays
          dev-only because a public-wall visitor should not be offered a file upload. */}
      {import.meta.env.DEV && (
        <>
          <button type="button" className="ppl__legolab" onClick={() => setLegoLab(true)}>
            🧱 LEGO avatar test
          </button>
          {legoLab && <LegoAvatarLab onClose={() => setLegoLab(false)} />}
        </>
      )}

      {/* The identity keeps the fixed header slot reserved by the title/roster offsets;
          SectionHome supplies the independent bottom-left Home target beside it. */}
      <SectionHome tone="light" className="ppl__brand" />

      <div className="ppl__layout">
        <aside className="ppl__intro">
          <h1 className="ppl__title">Team</h1>
        </aside>

        <div className="ppl__roster">
          {groups.map((group) => (
            <section className="ppl-group" key={group.label}>
              <h2 className="ppl-group__label">{group.label}</h2>
              <ul className="ppl-grid">
                {group.people.map((person) => (
                  <li
                    className="ppl-card"
                    key={person.id}
                    data-hover
                    onClick={() => setSelected(person)}
                  >
                    <span className="ppl-card__photo">
                      <img src={avatarUrl(person)} alt="" loading="lazy" />
                    </span>
                    <span className="ppl-card__name">
                      {person.firstName} {person.lastName}
                    </span>
                    {person.title && <span className="ppl-card__role">{person.title}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
