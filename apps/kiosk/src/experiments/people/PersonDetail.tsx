import { Fragment, useEffect, useRef } from "react";
import type { Person } from "../../../../../content/schema";
import { TypeShuffle } from "./typeShuffle";
// LEGO effect temporarily OFF — uncomment to restore the pixel-brick portrait.
// import { LegoAvatar } from "../../components/lego/LegoAvatar";
import "./detail.css";

/**
 * A person's profile rendered as the Codrops TypeShuffle "terminal" (effect 5): a dark,
 * monospace, uppercase file that "decodes" on entry. Left column = research + biography
 * (decoded); right card = the portrait (real cut-out through the LEGO pixel shader, else a
 * cartoon placeholder) with Name / Role / contact beneath it. Driven by the real roster
 * (content/people.json, CLAUDE.md rule 3). Dark via data-theme="dark" (design-system §5).
 *
 * Honors prefers-reduced-motion: the text simply renders settled, no scramble.
 */

// Cut-out (transparent-background) portraits under content/media/people/<id>.png, bundled by
// Vite. When a person has one, the card renders their real cut-out photo.
const cutouts = import.meta.glob<string>("../../../../../content/media/people/*.png", {
  eager: true,
  import: "default",
});
function cutoutUrl(id: string): string | undefined {
  return Object.entries(cutouts).find(([path]) => path.endsWith(`/${id}.png`))?.[1];
}

/** DiceBear cartoon fallback for people without a real cut-out portrait. */
function cartoonUrl(p: Person): string {
  return `https://api.dicebear.com/9.x/personas/svg?seed=${encodeURIComponent(
    `${p.firstName} ${p.lastName}`,
  )}&backgroundColor=transparent`;
}

/** Strip protocol + trailing slash for display (the href keeps the full URL). */
const prettyUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function PersonDetail({ person, onBack }: { person: Person; onBack: () => void }) {
  const contentRef = useRef<HTMLDListElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ts = new TypeShuffle(el);
    ts.trigger();
    return () => ts.destroy();
  }, [person.id]);

  const cut = cutoutUrl(person.id);
  const role = person.title || person.category;
  const bio = person.longBio || person.shortBio;
  const interests = person.researchInterests ?? [];
  const links = person.links ?? [];

  return (
    <div className="ppl-detail" data-theme="dark">
      <button type="button" className="ppl-detail__back" data-hover onClick={onBack}>
        ← Back
      </button>

      {/* Left column: research / biography, decoded by TypeShuffle. */}
      <dl className="ppl-detail__content" ref={contentRef}>
        {interests.length > 0 && (
          <>
            <dt>Research Interests</dt>
            <dd>
              {interests.map((it) => (
                <div key={it}>{it}</div>
              ))}
            </dd>
          </>
        )}
        {bio && (
          <>
            <dt>Biography</dt>
            <dd>{bio}</dd>
          </>
        )}
        {interests.length === 0 && !bio && (
          <dd className="ppl-detail__empty">
            Nothing to declare here — yet. This one lets the work do the talking. The
            essentials — who, where, how to reach them — are in the file on the right. →
          </dd>
        )}
      </dl>

      {/* Right card: portrait with the basics beneath it. */}
      <aside className="ppl-detail__card">
        <div className="ppl-detail__avatar" aria-hidden="true">
          {cut ? (
            // LEGO OFF — plain cut-out photo. To restore, swap this <img> back for:
            // <LegoAvatar src={cut} subdivision={46} dpr={2} interactive />
            <img src={cut} alt="" />
          ) : (
            <img src={cartoonUrl(person)} alt="" />
          )}
        </div>

        <dl className="ppl-detail__meta">
          <dt>Name</dt>
          <dd className="ppl-detail__name">
            {person.firstName} {person.lastName}
          </dd>

          <dt>Role</dt>
          <dd>{role}</dd>

          {person.email && (
            <>
              <dt>Email</dt>
              <dd>
                <a className="ppl-detail__link" data-hover href={`mailto:${person.email}`}>
                  {person.email}
                </a>
              </dd>
            </>
          )}

          {person.phone && (
            <>
              <dt>Phone</dt>
              <dd>{person.phone}</dd>
            </>
          )}

          {links.map((l) => (
            <Fragment key={l.url}>
              <dt>{l.label}</dt>
              <dd>
                <a
                  className="ppl-detail__link"
                  data-hover
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {prettyUrl(l.url)}
                </a>
              </dd>
            </Fragment>
          ))}

          {person.room && (
            <>
              <dt>Room</dt>
              <dd>{person.room}</dd>
            </>
          )}

          {person.officeHours && (
            <>
              <dt>Office Hours</dt>
              <dd>{person.officeHours}</dd>
            </>
          )}
        </dl>
      </aside>

      <div className="ppl-detail__tag" aria-hidden="true">
        PF // PERSONNEL FILE — {person.id}
      </div>
    </div>
  );
}
