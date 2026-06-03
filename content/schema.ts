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

/** People — individual profiles. Photos are folded in here (no separate gallery). */
export const personSchema = z.object({
  id,
  name: nonEmpty,
  role: nonEmpty, // "Professor", "PostDoc", "PhD Researcher", ...
  photo: nonEmpty, // main avatar, used on cards
  email: z.string().email().optional(),
  shortBio: nonEmpty, // 1–2 sentences for cards
  longBio: z.string().optional(), // full profile view
  researchInterests: z.array(nonEmpty),
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
  level: z.enum(["Bachelor", "Master"]),
  semester: nonEmpty, // "WS 2025/26", "SS 2026"
  ects: z.number().optional(),
  instructorIds: z.array(id), // → Person.id
  summary: nonEmpty,
  link: z.string().url().optional(), // TUMonline / Moodle
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
export const showreelFileSchema = z.array(spotlightItemSchema);

export type MediaItem = z.infer<typeof mediaItemSchema>;
export type Person = z.infer<typeof personSchema>;
export type ResearchTopic = z.infer<typeof researchTopicSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type StudentProject = z.infer<typeof studentProjectSchema>;
export type Course = z.infer<typeof courseSchema>;
export type SpotlightItem = z.infer<typeof spotlightItemSchema>;
