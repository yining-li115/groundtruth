import { useRef } from "react";
import type { Course } from "../../../../content/schema";
import { courses } from "../lib/content";
import { SectionLayout } from "../components/SectionLayout";
import { GlitchText, useGlitchOnHover } from "../components/GlitchText";
import "./teaching.css";

/** Course-type legend (matches the PRS course table). */
const TYPE_LEGEND = "VO Lecture · VI Lecture + Exercises · UE Exercise · SE Seminar · PR Practical";

/** Group courses by term, preserving the order terms first appear in the data. */
function byTerm(items: Course[]): { semester: string; items: Course[] }[] {
  const order: string[] = [];
  const map = new Map<string, Course[]>();
  for (const c of items) {
    if (!map.has(c.semester)) {
      map.set(c.semester, []);
      order.push(c.semester);
    }
    map.get(c.semester)!.push(c);
  }
  return order.map((semester) => ({ semester, items: map.get(semester)! }));
}

/** One course row — decodes (glitch) when the cursor hovers it. */
function CourseRow({ c }: { c: Course }) {
  const ref = useRef<HTMLDivElement>(null);
  useGlitchOnHover(ref);
  return (
    <div ref={ref} data-hover className="tch-row">
      <GlitchText className="tch-no" text={c.courseNo ?? "—"} />
      <GlitchText className="tch-title" text={c.title} />
      <GlitchText className="tch-hours" text={c.hoursPerWeek != null ? String(c.hoursPerWeek) : "—"} />
      <GlitchText className="tch-type" text={c.courseType ?? "—"} />
    </div>
  );
}

export function TeachingSection() {
  const terms = byTerm(courses);
  return (
    <SectionLayout title="Teaching">
      <div className="tch">
        {terms.map((term) => (
          <section key={term.semester} className="tch-term">
            <h2 className="tch-term-title">{term.semester}</h2>
            <div className="tch-head" aria-hidden="true">
              <span>Course no.</span>
              <span>Title</span>
              <span>Hours</span>
              <span>Type</span>
            </div>
            <div className="tch-rows">
              {term.items.map((c) => (
                <CourseRow key={c.id} c={c} />
              ))}
            </div>
          </section>
        ))}
        <p className="tch-legend">{TYPE_LEGEND}</p>
      </div>
    </SectionLayout>
  );
}
