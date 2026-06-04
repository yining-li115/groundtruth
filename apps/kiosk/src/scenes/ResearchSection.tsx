import { topics, personName } from "../lib/content";
import { SectionLayout } from "../components/SectionLayout";

export function ResearchSection() {
  return (
    <SectionLayout title="Research">
      <ul className="grid gap-5">
        {topics.map((t) => (
          <li key={t.id} className="gt-card">
            <p className="text-xl font-medium">{t.title}</p>
            <p className="mt-1 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
              {t.summary}
            </p>
            <p className="mt-3 text-xs" style={{ color: "var(--gt-accent)" }}>
              {t.tags.join(" · ")}
            </p>
            <p className="mt-2 text-xs" style={{ color: "var(--gt-text-secondary)" }}>
              Lead: {t.leadPersonIds.map(personName).join(", ")}
            </p>
          </li>
        ))}
      </ul>
    </SectionLayout>
  );
}
