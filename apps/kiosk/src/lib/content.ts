/**
 * Typed access to the content/*.json data. Content is data, not code (CLAUDE.md rule
 * 3): these JSON files are the source, validated by `npm run check:content`. We import
 * the types from content/schema.ts (type-only, so zod is not bundled) and the JSON as
 * data. Vite bundles the JSON at build time.
 */
import type {
  Person,
  ResearchTopic,
  StudentProject,
  Course,
  Paper,
  SpotlightItem,
} from "../../../../content/schema";
import type { View } from "../state/store";
import peopleRaw from "../../../../content/people.json";
import topicsRaw from "../../../../content/research-topics.json";
import projectsRaw from "../../../../content/student-projects.json";
import coursesRaw from "../../../../content/courses.json";
import papersRaw from "../../../../content/papers.json";
import showreelRaw from "../../../../content/showreel.json";

export const people = peopleRaw as unknown as Person[];
export const topics = topicsRaw as unknown as ResearchTopic[];
export const projects = projectsRaw as unknown as StudentProject[];
export const courses = coursesRaw as unknown as Course[];
export const papers = papersRaw as unknown as Paper[];
export const showreel = showreelRaw as unknown as SpotlightItem[];

const personById = new Map(people.map((p) => [p.id, p]));
const topicById = new Map(topics.map((t) => [t.id, t]));
const projectById = new Map(projects.map((p) => [p.id, p]));
const courseById = new Map(courses.map((c) => [c.id, c]));

/** Resolve a Person id to a display name (falls back to the id). */
export const personName = (id: string): string => personById.get(id)?.name ?? id;
/** Resolve a ResearchTopic id to its title (falls back to the id). */
export const topicTitle = (id: string): string => topicById.get(id)?.title ?? id;

/** Which section page an item id belongs to — used to jump from a showreel refId. */
export function viewForId(id: string): View | null {
  if (personById.has(id)) return "people";
  if (topicById.has(id)) return "research";
  if (projectById.has(id)) return "projects";
  if (courseById.has(id)) return "teaching";
  return null;
}
