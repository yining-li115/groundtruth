# content/

Content is **data, not code** (CLAUDE.md rule 3). Section content lives here as JSON
files matching the schema in `docs/content-model.md`, with media under `media/`.

**Phase 0 status:** folder structure only. The JSON files (`people.json`,
`research-topics.json`, `student-projects.json`, `courses.json`, `photos.json`,
`showreel.json`), the `zod` schema, and the `npm run check:content` validator arrive
in **Phase 2** (see `docs/roadmap.md`).

## Media folders (content-model.md §"Media / image folder convention")

```
media/
├── people/      ← staff photos, named by person id (jane-doe.jpg)
├── topics/      ← research topic covers + media
├── projects/    ← student project covers + media
├── photos/      ← gallery images
└── showreel/    ← spotlight / news imagery
```
