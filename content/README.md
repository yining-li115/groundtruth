# content/

Content is **data, not code** (CLAUDE.md rule 3). Section content lives here as JSON
files matching the schema in `docs/content-model.md`, with media under `media/`.

## Files

- `people.json` — group members (photos folded in here; no standalone gallery)
- `research-topics.json` — group research topics
- `student-projects.json` — student theses / projects
- `courses.json` — teaching
- `showreel.json` — idle/home feed (news lives here as `kind: "news"`)
- `schema.ts` — the zod schema + inferred TS types (single source of truth for shape)

Validate after any edit:

```
npm run check:content
```

It checks JSON validity, the schema, duplicate ids, dangling cross-references, and that
every non-URL media path exists on disk. Green = safe to ship.

## Media folders

```
media/
├── people/      ← headshots AND detail-page photos, named by person id (jane-doe.jpg)
├── topics/      ← research topic covers + media
├── projects/    ← student project covers + media
└── showreel/    ← spotlight / news imagery
```

A value starting with `http(s)://` is an external URL (e.g. DiceBear/picsum
placeholders) and isn't checked on disk; anything else is a filename under
`media/<type>/`. The shipped placeholder data uses URLs.
