/**
 * Content validator — `npm run check:content`.
 *
 * Validates every content/*.json against content/schema.ts (zod), then checks the
 * things zod alone can't: duplicate ids, dangling cross-references between files, and
 * that every media path that isn't an external URL actually exists under content/media/.
 * Prints a clear per-file report and exits non-zero on any problem, so a bad edit can
 * never reach production (docs/content-model.md, CLAUDE.md rule 3).
 *
 * Run with tsx (no build step): see the root package.json script.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import {
  peopleFileSchema,
  researchTopicsFileSchema,
  studentProjectsFileSchema,
  coursesFileSchema,
  papersFileSchema,
  showreelFileSchema,
} from "../content/schema";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = resolve(ROOT, "content");
const MEDIA = resolve(CONTENT, "media");

const errors: string[] = [];
const fail = (file: string, msg: string) => errors.push(`${file}: ${msg}`);
const isUrl = (s: string) => /^https?:\/\//i.test(s);
/** External URL or an app-served absolute path (e.g. "/papers/..."): not on disk here. */
const isExternal = (s: string) => isUrl(s) || s.startsWith("/");

/** Parse + schema-validate one file. Returns the typed array, or undefined on failure. */
function load(file: string, schema: ZodTypeAny): any[] | undefined {
  const path = resolve(CONTENT, file);
  if (!existsSync(path)) {
    fail(file, "file not found");
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(file, `invalid JSON — ${(e as Error).message}`);
    return undefined;
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    for (const issue of res.error.issues) {
      const where = issue.path.length ? `item[${issue.path.join(".")}]` : "(root)";
      fail(file, `${where} — ${issue.message}`);
    }
    return undefined;
  }
  return res.data as any[];
}

/** Unique-id check within one file. */
function checkUniqueIds(file: string, items: any[]) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) fail(file, `duplicate id "${item.id}"`);
    seen.add(item.id);
  }
}

/** Every id in `refs` must exist in `valid`, else it's a dangling reference. */
function checkRefs(file: string, ownerId: string, field: string, refs: string[] | undefined, valid: Set<string>) {
  for (const ref of refs ?? []) {
    if (!valid.has(ref)) fail(file, `"${ownerId}".${field} → unknown id "${ref}"`);
  }
}

/** A non-URL media value must resolve to a real file under content/media/<dir>/. */
function checkMedia(file: string, ownerId: string, dir: string, values: (string | undefined)[]) {
  for (const value of values) {
    if (!value || isExternal(value)) continue;
    const path = resolve(MEDIA, dir, value);
    if (!existsSync(path)) {
      fail(file, `"${ownerId}" media "${value}" not found at content/media/${dir}/${value}`);
    }
  }
}

const people = load("people.json", peopleFileSchema);
const topics = load("research-topics.json", researchTopicsFileSchema);
const projects = load("student-projects.json", studentProjectsFileSchema);
const courses = load("courses.json", coursesFileSchema);
const papers = load("papers.json", papersFileSchema);
const showreel = load("showreel.json", showreelFileSchema);

const idsOf = (items?: any[]) => new Set((items ?? []).map((i) => i.id));
const personIds = idsOf(people);
const topicIds = idsOf(topics);
const projectIds = idsOf(projects);
const allIds = new Set<string>([...personIds, ...topicIds, ...projectIds, ...idsOf(courses)]);

if (people) {
  checkUniqueIds("people.json", people);
  for (const p of people) {
    checkRefs("people.json", p.id, "relatedTopicIds", p.relatedTopicIds, topicIds);
    checkRefs("people.json", p.id, "relatedProjectIds", p.relatedProjectIds, projectIds);
    checkMedia("people.json", p.id, "people", [p.photo, ...(p.photos ?? []).map((x: any) => x.src)]);
  }
}

if (topics) {
  checkUniqueIds("research-topics.json", topics);
  for (const t of topics) {
    checkRefs("research-topics.json", t.id, "leadPersonIds", t.leadPersonIds, personIds);
    checkMedia("research-topics.json", t.id, "topics", [
      t.cover,
      ...(t.media ?? []).flatMap((m: any) => [m.src, m.poster]),
    ]);
  }
}

if (projects) {
  checkUniqueIds("student-projects.json", projects);
  for (const pr of projects) {
    checkRefs("student-projects.json", pr.id, "supervisorIds", pr.supervisorIds, personIds);
    checkRefs("student-projects.json", pr.id, "topicIds", pr.topicIds, topicIds);
    checkMedia("student-projects.json", pr.id, "projects", [
      pr.cover,
      ...(pr.media ?? []).flatMap((m: any) => [m.src, m.poster]),
    ]);
  }
}

if (courses) {
  checkUniqueIds("courses.json", courses);
  for (const c of courses) {
    checkRefs("courses.json", c.id, "instructorIds", c.instructorIds, personIds);
  }
}

if (papers) {
  checkUniqueIds("papers.json", papers);
  for (const p of papers) {
    checkMedia("papers.json", p.id, "papers", p.images ?? []);
  }
}

if (showreel) {
  checkUniqueIds("showreel.json", showreel);
  for (const s of showreel) {
    if (s.refId) checkRefs("showreel.json", s.id, "refId", [s.refId], allIds);
    checkMedia("showreel.json", s.id, "showreel", [s.media?.src, s.media?.poster]);
  }
}

const counts = {
  people: people?.length ?? "ERR",
  topics: topics?.length ?? "ERR",
  projects: projects?.length ?? "ERR",
  courses: courses?.length ?? "ERR",
  papers: papers?.length ?? "ERR",
  showreel: showreel?.length ?? "ERR",
};

if (errors.length) {
  console.error(`\n✗ check:content found ${errors.length} problem(s):\n`);
  for (const e of errors) console.error("  - " + e);
  console.error("");
  process.exit(1);
}

console.log("✓ check:content passed");
console.log(
  `  people ${counts.people} · topics ${counts.topics} · projects ${counts.projects} · courses ${counts.courses} · papers ${counts.papers} · showreel ${counts.showreel}`,
);
