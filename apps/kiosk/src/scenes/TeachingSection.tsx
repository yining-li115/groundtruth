import { courses, personName } from "../lib/content";
import { SectionLayout } from "../components/SectionLayout";

export function TeachingSection() {
  return (
    <SectionLayout title="Teaching">
      <ul className="grid gap-5 md:grid-cols-2">
        {courses.map((c) => (
          <li key={c.id} className="gt-card">
            <p className="text-lg font-medium">{c.title}</p>
            <p className="mt-1 text-sm font-medium" style={{ color: "var(--gt-accent)" }}>
              {c.level} · {c.semester}
              {typeof c.ects === "number" ? ` · ${c.ects} ECTS` : ""}
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
              {c.summary}
            </p>
            <p className="mt-2 text-xs" style={{ color: "var(--gt-text-secondary)" }}>
              Taught by: {c.instructorIds.map(personName).join(", ")}
            </p>
          </li>
        ))}
      </ul>
    </SectionLayout>
  );
}
