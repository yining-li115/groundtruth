import { projects, personName } from "../lib/content";
import { SectionLayout } from "../components/SectionLayout";

export function ProjectsSection() {
  return (
    <SectionLayout title="Student projects">
      <ul className="grid gap-5">
        {projects.map((pr) => (
          <li key={pr.id} className="gt-card">
            <p className="text-xl font-medium">{pr.title}</p>
            <p className="mt-1 text-sm font-medium" style={{ color: "var(--gt-accent)" }}>
              {pr.type} · {pr.year}
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--gt-text-secondary)" }}>
              {pr.abstract}
            </p>
            <p className="mt-2 text-xs" style={{ color: "var(--gt-text-secondary)" }}>
              Students: {pr.students.join(", ")} · Supervisors:{" "}
              {pr.supervisorIds.map(personName).join(", ")}
            </p>
          </li>
        ))}
      </ul>
    </SectionLayout>
  );
}
