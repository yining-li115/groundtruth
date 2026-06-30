/**
 * Content schema — the single source of truth for the SHAPE of everything in content/.
 * Defined with zod so the same definition both (a) validates the JSON via
 * `npm run check:content` and (b) exports inferred TypeScript types for the apps.
 *
 * Content is data, not code (CLAUDE.md rule 3): components render these shapes, never
 * embed copy. To add a field, change it HERE (and the JSON), never in a component.
 *
 * NOTE (Phase 2 decision): there is no standalone Photo/Gallery type. Photos live on
 * People — `photo` is the single avatar used on cards; `photos[]` is the detail-page
 * gallery. See docs/content-model.md.
 *
 * Media values: a value beginning with http:// or https:// is treated as an EXTERNAL
 * URL (e.g. DiceBear avatars, picsum placeholders) and is not checked on disk. Any
 * other value is a filename resolved under content/media/<type>/ and must exist.
 */
import { z } from "zod";

const id = z.string().min(1);
const nonEmpty = z.string().min(1);

export const mediaItemSchema = z.object({
  kind: z.enum(["image", "video", "pointcloud", "model"]),
  src: nonEmpty,
  poster: z.string().optional(),
  caption: z.string().optional(),
});

export const linkSchema = z.object({
  label: nonEmpty,
  url: z.string().url(),
});

export const personPhotoSchema = z.object({
  src: nonEmpty,
  caption: z.string().optional(),
});

/** People — individual profiles. Photos are folded in here (no separate gallery).
 *  The roster (People section) groups members by `category`; the only required fields are
 *  the name parts + category + a stable id, so adding a person is just a few lines of JSON.
 *  The richer fields (bio, interests, photos, links) are optional, filled in for whoever has
 *  a detail page. `photo` is optional too — when absent the section shows a generated
 *  placeholder avatar, so a new member needs no image to appear. */
export const personSchema = z.object({
  id,
  firstName: nonEmpty,
  lastName: nonEmpty,
  category: nonEmpty, // roster group, e.g. "Director", "Secretary", "Research Associates"
  title: z.string().optional(), // academic degree, e.g. "Prof. Dr. rer. nat.", "M.Sc."
  email: z.string().email().optional(),
  room: z.string().optional(), // office, e.g. "1781" or "STC"
  photo: z.string().optional(), // main avatar (filename/URL); placeholder generated if absent
  shortBio: z.string().optional(), // 1–2 sentences for cards
  longBio: z.string().optional(), // full profile view
  researchInterests: z.array(nonEmpty).optional(),
  photos: z.array(personPhotoSchema).optional(), // detail-page gallery
  links: z.array(linkSchema).optional(),
  relatedTopicIds: z.array(id).optional(), // → ResearchTopic.id
  relatedProjectIds: z.array(id).optional(), // → StudentProject.id
});

export const publicationSchema = z.object({
  title: nonEmpty,
  authors: nonEmpty,
  venue: nonEmpty,
  year: z.number().int(),
  url: z.string().url().optional(),
});

export const researchTopicSchema = z.object({
  id,
  title: nonEmpty,
  summary: nonEmpty, // card-level
  description: nonEmpty, // detail view
  cover: nonEmpty,
  tags: z.array(nonEmpty),
  leadPersonIds: z.array(id), // → Person.id
  publications: z.array(publicationSchema).optional(),
  media: z.array(mediaItemSchema).optional(),
});

export const studentProjectSchema = z.object({
  id,
  title: nonEmpty,
  type: z.enum(["Bachelor", "Master", "Guided Research", "IDP", "Other"]),
  year: z.number().int(),
  students: z.array(nonEmpty), // names (not necessarily group members)
  supervisorIds: z.array(id), // → Person.id
  abstract: nonEmpty,
  cover: nonEmpty,
  topicIds: z.array(id).optional(), // → ResearchTopic.id
  media: z.array(mediaItemSchema).optional(),
});

export const courseSchema = z.object({
  id,
  title: nonEmpty,
  // Real PRS course-table fields (the site exposes these, not Bachelor/Master + ECTS):
  courseNo: z.string().optional(), // TUMonline number, e.g. "0000000822"
  courseType: z.enum(["VO", "VI", "UE", "SE", "PR"]).optional(), // lecture / lec+ex / exercise / seminar / practical
  hoursPerWeek: z.number().optional(), // SWS
  semester: nonEmpty, // display term label, e.g. "Winter Term 2025/26"
  // Optional extras (not on the public course table; kept for future TUMonline enrichment):
  level: z.enum(["Bachelor", "Master"]).optional(),
  ects: z.number().optional(),
  instructorIds: z.array(id).optional(), // → Person.id
  summary: z.string().optional(),
  link: z.string().url().optional(), // TUMonline / Moodle
});

/** Papers / publications — the group's research output, shown on the Publications page
 *  (PhD papers, with figure galleries). Figures live app-served under
 *  apps/kiosk/public/papers/<id>/ (large, gitignored) and are referenced as
 *  "/papers/..."; the validator skips disk-checking app/URL paths. */
export const paperSchema = z.object({
  id,
  title: nonEmpty,
  authors: z.array(nonEmpty),
  venue: nonEmpty,
  year: z.number().int(),
  type: nonEmpty, // hover sub-label / detail tag, e.g. "CVPR 2026"
  abstract: nonEmpty,
  url: z.string().url().optional(),
  images: z.array(nonEmpty).optional(),
});

/** Open topics — student projects OFFERED by the group (not completed work), shown on the
 *  Student Projects page and filtered by `type` via the GooeyNav tabs. Each is an offer a
 *  student can take; it has no authors/venue/year (those belong to a finished project). */
export const openTopicType = z.enum([
  "IDP",
  "Guided Research",
  "Semester Arbeit",
  "Bachelor Thesis",
  "Master Thesis",
]);
export const openTopicSchema = z.object({
  id,
  title: nonEmpty,
  // One or more of the five filter categories — a topic may be open as several kinds at
  // once (e.g. both an IDP and a Master Thesis). The page filter matches by membership.
  types: z.array(openTopicType).min(1),
  summary: nonEmpty, // one-line teaser (hover / detail intro)
  description: nonEmpty, // the offer: what the student would do
  posted: z.string().optional(), // ISO date "YYYY-MM-DD" — sorts the "All" tab (newest first)
  supervisorId: id.optional(), // → Person.id
  prerequisites: z.array(nonEmpty).optional(),
});

/** Showreel / idle feed. News lives here as a SpotlightItem with kind: "news". */
export const spotlightItemSchema = z.object({
  id,
  kind: z.enum(["spotlight", "news", "open-topic"]),
  title: nonEmpty,
  blurb: nonEmpty,
  media: mediaItemSchema.optional(),
  cta: z.string().optional(),
  refId: z.string().optional(), // optional link into a section item
});

// Each content/*.json file is an array of one of the above.
export const peopleFileSchema = z.array(personSchema);
export const researchTopicsFileSchema = z.array(researchTopicSchema);
export const studentProjectsFileSchema = z.array(studentProjectSchema);
export const coursesFileSchema = z.array(courseSchema);
export const papersFileSchema = z.array(paperSchema);
export const openTopicsFileSchema = z.array(openTopicSchema);
export const showreelFileSchema = z.array(spotlightItemSchema);

export type MediaItem = z.infer<typeof mediaItemSchema>;
export type Person = z.infer<typeof personSchema>;
export type ResearchTopic = z.infer<typeof researchTopicSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type StudentProject = z.infer<typeof studentProjectSchema>;
export type Course = z.infer<typeof courseSchema>;
export type Paper = z.infer<typeof paperSchema>;
export type OpenTopicType = z.infer<typeof openTopicType>;
export type OpenTopic = z.infer<typeof openTopicSchema>;
export type SpotlightItem = z.infer<typeof spotlightItemSchema>;
