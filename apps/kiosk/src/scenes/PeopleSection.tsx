import { people } from "../lib/content";
import { SectionLayout } from "../components/SectionLayout";

export function PeopleSection() {
  return (
    <SectionLayout title="People">
      <ul className="grid gap-5 md:grid-cols-2">
        {people.map((p) => (
          <li key={p.id} className="gt-card flex gap-5">
            <img
              src={p.photo}
              alt=""
              width={72}
              height={72}
              className="h-[72px] w-[72px] shrink-0 rounded-full"
              style={{ background: "var(--gt-bg)" }}
            />
            <div>
              <p className="text-lg font-medium">{p.name}</p>
              <p className="text-sm font-medium" style={{ color: "var(--gt-accent)" }}>
                {p.role}
              </p>
              <p className="mt-1.5 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
                {p.shortBio}
              </p>
              <p className="mt-2 text-xs" style={{ color: "var(--gt-text-secondary)" }}>
                {p.researchInterests.join(" · ")}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </SectionLayout>
  );
}
