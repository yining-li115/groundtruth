import { useEffect, useRef } from "react";
import type { PersonRow } from "./peopleData";
import { avatarUrl } from "./peopleData";
import { TypeShuffle } from "./typeShuffle";

/**
 * A person's profile rendered as the Codrops TypeShuffle "terminal" (effect 5): a dark,
 * monospace, uppercase definition list that decodes line-by-line on entry. Dark via
 * `data-theme="dark"` (the same token-swap the Projects section uses), so the bg/type
 * come from tokens — only the mid-shuffle flash colors are off-token (./effectColors).
 *
 * Honors prefers-reduced-motion: the text simply renders settled, no scramble.
 */
export function PersonDetail({ person, onBack }: { person: PersonRow; onBack: () => void }) {
  const contentRef = useRef<HTMLDListElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ts = new TypeShuffle(el);
    ts.trigger();
    return () => ts.destroy();
  }, [person.id]);

  const p = person.profile;

  return (
    <div className="ppl-detail" data-theme="dark">
      <button type="button" className="ppl-detail__back" data-hover onClick={onBack}>
        ← Back
      </button>

      <div className="ppl-detail__avatar" aria-hidden="true">
        <img src={avatarUrl(person)} alt="" width={104} height={104} />
      </div>

      <dl className="ppl-detail__content" ref={contentRef}>
        <dt>Name</dt>
        <dd>
          {person.first} {person.last}
        </dd>

        <dt>Role</dt>
        <dd>{person.title || "—"}</dd>

        <dt>Email</dt>
        <dd>{person.email}</dd>

        {p?.website && (
          <>
            <dt>Website</dt>
            <dd>{p.website}</dd>
          </>
        )}

        {person.room && (
          <>
            <dt>Room</dt>
            <dd>{person.room}</dd>
          </>
        )}

        {p && (
          <>
            <dt>Research Interests</dt>
            <dd>
              {p.researchInterests.map((it) => (
                <div key={it}>{it}</div>
              ))}
              {p.researchNote && <div className="ppl-detail__note">{p.researchNote}</div>}
            </dd>

            {p.recentWork && (
              <>
                <dt>Recent Work</dt>
                <dd>{p.recentWork}</dd>
              </>
            )}

            <dt>Professional Services</dt>
            <dd>
              {p.professionalServices.map((s) => (
                <div key={s}>{s}</div>
              ))}
            </dd>

            <dt>Curriculum Vitae</dt>
            <dd>{p.curriculumVitae}</dd>
          </>
        )}
      </dl>

      <div className="ppl-detail__tag" aria-hidden="true">
        PF // PERSONNEL FILE — {person.id}
      </div>
    </div>
  );
}
