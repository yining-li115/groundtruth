import { useEffect, useRef } from "react";
import { Logo } from "@groundtruth/ui";
import type { Person } from "../../../../content/schema";
import { people } from "../lib/content";
import { KioskMenu } from "../components/KioskMenu";
import { navigate } from "../lib/navigate";
import { activePointer } from "../lib/cursorPosition";
import "./people.css";

/**
 * People — the group roster. Content is data (content/people.json, CLAUDE.md rule 3): each
 * member carries a `category`, and we group by it in a fixed order, so adding a person is a
 * JSON edit that lands in the right group automatically. Layout mirrors the design locked in
 * the ?exp=people prototype: a sticky "TEAM" intro beside a grid of portrait cards, with a
 * cursor-proximity scale "lens" driven by the kiosk cursor (works for the phone-driven pointer
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

/** A member's card image: their `photo` if set, else a generated placeholder from the name. */
function avatarUrl(p: Person): string {
  if (p.photo) return p.photo;
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
 *  Driven by activePointer() in a rAF loop so it follows the phone-driven cursor on the wall
 *  and a real mouse in dev alike. Reduced motion opts out. */
function useProximityScale(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const items = [...root.querySelectorAll<HTMLElement>(".ppl-card, .ppl-group__label, .ppl__title")];
    if (!items.length) return;
    const scales = new Array(items.length).fill(1);
    const RADIUS = 220;
    const MAX_SCALE = 1.6;
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
  }, [rootRef]);
}

export function PeopleSection() {
  const pageRef = useRef<HTMLDivElement>(null);
  useProximityScale(pageRef);

  const groups = groupByCategory(people);

  return (
    <div className="ppl" ref={pageRef} style={{ color: "var(--gt-text-primary)" }}>
      <KioskMenu />

      <button type="button" className="ppl__brand" aria-label="Back to home" onClick={() => navigate("home")}>
        <span className="ppl__brand-text">
          <span className="ppl__brand-strong">
            Professorship of Photogrammetry and Remote Sensing
          </span>
          <span>TUM School of Engineering and Design</span>
          <span>Technical University of Munich</span>
        </span>
        <Logo variant="black" width={64} height={33} />
      </button>

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
                  <li className="ppl-card" key={person.id}>
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
