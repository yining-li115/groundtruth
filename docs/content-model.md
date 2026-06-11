# Content Model

Content is **data, not code** (CLAUDE.md rule 3). All section content lives in
`content/` as **JSON files**. Components render this data; they never embed copy or
image paths inline. This is what makes the site easy to maintain: adding a new staff
member, project, or news item = editing a JSON file, never touching React code.

## How this works (read this first)

- Each content type has **one JSON file** in `content/` (e.g. `content/people.json`).
- The **shape** of each item is defined by a TypeScript type below. These types are the
  contract: they say which fields exist, which are required, and what type each is.
- A **validation script** (`npm run check:content`) checks every JSON file against
  these types. If you mistype a field name, forget a required field, leave a dangling
  comma, or reference a missing image, it tells you exactly which file and line is
  wrong — BEFORE you deploy. Run it after every edit.
- Implementation note for Claude Code: derive the validator from these types using
  `zod` (define a zod schema mirroring each type, parse each JSON file, print a clear
  per-file/per-item error on failure). Wire it to `npm run check:content` and run it in
  CI so a bad edit can never reach production.

The types below are written in TypeScript notation because that's the precise way to
describe the shape — but the actual content you edit is plain JSON. A `Person` type
field `name: string` means the JSON object has `"name": "..."`.

There are **four content sections** (People, Research topics, Student projects,
Teaching) plus the showreel feed. There is **no standalone Photo gallery** — all photos
belong to a person (see §1).

Below are the v1 fields — extend as real content arrives, but keep the core stable.
When you add or change a field here, update the zod schema so validation stays in sync.

---

## 1. People (individual profiles)

The PF group members. Each person is also the target of "individual content" in the
interactive flow: the People section shows a thumbnail card per person; tapping a card
opens that person's detail page. JSON file: `content/people.json` (an array of these
objects).

```ts
type Person = {
  id: string;              // slug, e.g. "jane-doe"
  name: string;
  role: string;            // "Professor", "PhD Researcher", "PostDoc", ...
  photo: string;           // main headshot — shown on the thumbnail card
  photos?: { src: string; caption?: string }[];  // extra photos for the detail page
  email?: string;
  shortBio: string;        // 1–2 sentences for cards
  longBio?: string;        // full profile view
  researchInterests: string[];
  links?: { label: string; url: string }[];  // scholar, github, personal site
  relatedTopicIds?: string[];   // → ResearchTopic.id
  relatedProjectIds?: string[]; // → StudentProject.id
};
```

Note on photos: `Person.photo` is the single main headshot used on the thumbnail card.
`Person.photos` is the set of additional images shown on the individual detail page
(work photos, results, etc.). There is **no separate "photo wall" section** — every
photo is owned by a specific person, so it always has context (whose it is, what it
shows).

## 2. Research topics (group)

JSON file: `content/research-topics.json` (an array of these objects).

```ts
type ResearchTopic = {
  id: string;
  title: string;
  summary: string;          // card-level
  description: string;      // detail view
  cover: string;            // image/video path
  tags: string[];           // e.g. ["point cloud", "SAR", "deep learning"]
  leadPersonIds: string[];  // → Person.id
  publications?: Publication[];
  media?: MediaItem[];      // extra imagery, point-cloud assets, etc.
};

type Publication = {
  title: string;
  authors: string;
  venue: string;
  year: number;
  url?: string;
};
```

## 3. Student projects

JSON file: `content/student-projects.json` (an array of these objects).

```ts
type StudentProject = {
  id: string;
  title: string;
  type: "Bachelor" | "Master" | "Guided Research" | "IDP" | "Other";
  year: number;
  students: string[];        // names (not necessarily group members)
  supervisorIds: string[];   // → Person.id
  abstract: string;
  cover: string;
  topicIds?: string[];       // → ResearchTopic.id
  media?: MediaItem[];
};
```

## 4. Teaching

JSON file: `content/courses.json` (an array of these objects).

```ts
type Course = {
  id: string;
  title: string;
  // The real PRS course table exposes these (not Bachelor/Master + ECTS):
  courseNo?: string;         // TUMonline number, e.g. "0000000822"
  courseType?: "VO" | "VI" | "UE" | "SE" | "PR"; // lecture / lec+ex / exercise / seminar / practical
  hoursPerWeek?: number;     // SWS (hours per week)
  semester: string;          // display term label, e.g. "Winter Term 2025/26"
  // Not on the public table — optional, for future TUMonline enrichment:
  level?: "Bachelor" | "Master";
  ects?: number;
  instructorIds?: string[];  // → Person.id
  summary?: string;
  link?: string;             // TUMonline / Moodle
};
```

`content/courses.json` holds the **real** Winter 2025/26 + Summer 2026 courses (from
`asg.ed.tum.de/en/pf/teaching/courses/`). The Teaching page renders them as a term-grouped,
monospace table (Course no. / Title / Hours / Type) where each row "decode"-glitches on hover
(`components/GlitchText.tsx`). The public page has no images/video; each course links to
TUMonline.

## 5. Shared

```ts
type MediaItem = {
  kind: "image" | "video" | "pointcloud" | "model";
  src: string;
  poster?: string;           // for video/3d
  caption?: string;
};
```

## 6. Showreel / idle content

What the kiosk auto-plays when no one is driving. The **interactive home** may also
*surface* some of these items, but the home and the idle showreel are **independent
presentations** that merely share this content as source material — there is no shared
"mode" component and no obligation to look alike (see `docs/architecture.md` §6).
JSON file: `content/showreel.json` (an array of these objects). **This is where "news"
lives** — a news item is a `SpotlightItem` with `kind: "news"`.

```ts
type SpotlightItem = {
  id: string;
  kind: "spotlight" | "news" | "open-topic";
  title: string;
  blurb: string;
  media?: MediaItem;
  cta?: string;              // e.g. "Scan to explore"
  refId?: string;            // optional link into a section item
};
```

---

## Notes

- IDs are slugs and stable; cross-references use IDs (see `relatedTopicIds`, etc.) so
  the relationship graph (person ↔ topic ↔ project) can power "related" navigation.
- Media paths are relative to `content/media/`. Real assets land later; ship
  placeholders first.
- **External URLs are allowed.** A media value starting with `http://` or `https://`
  (e.g. DiceBear avatars, picsum placeholders) is treated as an external URL and is NOT
  checked on disk by the validator. Any other value is a filename resolved under
  `content/media/<type>/` and must exist. The shipped placeholder data uses URLs; real
  assets become local files.
- Implemented: the zod schema lives at `content/schema.ts` (also exports inferred TS
  types) and the validator at `scripts/check-content.ts` (`npm run check:content`).
- Point-cloud / 3D assets (the on-brand WebGL material for a remote-sensing group)
  attach via `MediaItem` with `kind: "pointcloud" | "model"` and are consumed by the
  `apps/kiosk/src/webgl` layer.

---

## Media / image folder convention

Images and media are NOT pasted into JSON — JSON only stores the **filename**. The
files themselves live in `content/media/`, organized by type:

```
content/media/
├── people/          ← staff photos: headshots AND detail-page photos, named by id
├── topics/          ← research topic covers + media
├── projects/        ← student project covers + media
└── showreel/        ← spotlight / news imagery
```

Rule: a JSON field like `"photo": "jane-doe.jpg"` resolves to
`content/media/people/jane-doe.jpg`. Name files after the item's `id` so they're easy
to find and never collide (for a person's extra photos, suffix them, e.g.
`jane-doe-2.jpg`, `jane-doe-fieldwork.jpg`). Keep images reasonably sized (the kiosk is
one big screen, not a 4K photo viewer) — large originals slow the showreel.

---

## HOW-TO: maintaining content (for whoever holds this role)

You don't need to touch any code to update what the wall shows. Everything is JSON in
`content/`. The pattern is the same for all content types. **After any edit, run
`npm run check:content` — it catches mistakes before they reach the screen.**

### Add a new staff member
1. Put their photo in `content/media/people/`, named after their id, e.g. `li-wei.jpg`.
   For extra detail-page photos, add more files like `li-wei-2.jpg`.
2. Open `content/people.json`. Copy the last entry, paste it, and edit the fields
   (`id`, `name`, `role`, `photo`, `shortBio`, …). The `id` must be unique and is a
   lowercase slug (e.g. `"li-wei"`). `photo` is just the filename: `"li-wei.jpg"`.
   Add extra photos in `photos`, e.g.
   `"photos": [{ "src": "li-wei-2.jpg", "caption": "Fieldwork in the Alps" }]`.
3. Save. Run `npm run check:content`. If it's green, preview locally / redeploy. The
   new profile card appears automatically.

### Add a news item
1. Open `content/showreel.json`.
2. Copy an existing entry with `"kind": "news"`, edit `title`, `blurb`, optional
   `media`. If it has an image, drop the file in `content/media/showreel/` first.
3. Save, validate, redeploy. It joins the idle showreel rotation (and may also be
   surfaced on the interactive home, which reads the same JSON as source).

### Add a student project
1. (Optional) cover image → `content/media/projects/`.
2. Open `content/student-projects.json`, copy the last entry, edit fields. Link
   supervisors via their `Person` id in `supervisorIds`, and topics via `topicIds`.
3. Save, validate, redeploy.

### Remove or edit something
Just delete or change the relevant object in the JSON file, validate, redeploy. To
remove a person who is referenced elsewhere (e.g. a project's `supervisorIds`), the
validator will flag the now-dangling reference so you don't leave broken links.

### Common mistakes the validator catches
- Trailing or missing commas in JSON (the #1 cause of a broken site).
- A misspelled field name (`"rol"` instead of `"role"`).
- A missing required field.
- A `photo`/`cover` filename that doesn't exist in `content/media/`.
- A cross-reference id (e.g. `supervisorIds`) that points to no existing item.

### Golden rules for the maintainer
- Never edit `.tsx`/code files to add content. If you find yourself doing that, the
  content model is missing a field — add the field to the schema instead.
- Always run `npm run check:content` before deploying. Green = safe.
- Keep a backup/commit before big edits (`git commit` is your undo button).