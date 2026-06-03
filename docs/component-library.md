# Component Library

The goal: a reusable, **fully TUM-ified** component library in `packages/ui`, built up
over time by adapting best-in-class open-source components and documenting each one in
Storybook. Built once, reused across this and future group projects.

---

## 1. Sources to adapt from (copy-paste libraries)

These are **copy-paste**, not npm dependencies — you copy the source in and own it.
That's intended: it means we can recolor to TUM tokens and strip what we don't need.

- **React Bits** (`reactbits.dev`) — best for text effects (blur/split/gradient text),
  particle backgrounds, fluid cursors. First stop for Lusion-style text reveals.
- **Aceternity UI** (`ui.aceternity.com`) — 3D cards, glowing beams, magnetic buttons,
  particle backgrounds (Tailwind + Framer Motion).
- **Magic UI** (`magicui.design`) — marquees, animated beams, number tickers (good for
  stats: publication counts, project counts).
- **shadcn/ui** (`ui.shadcn.com`) — plain, accessible primitives (buttons, lists,
  progress bars) for the controller UI where polish > flash isn't the goal.

For WebGL particle/point-cloud components, see `docs/architecture.md` and the R3F
ecosystem (`r3f-particle-field`, `r3f-flow-field-particles`) — same adapt-and-own flow.

---

## 2. The pipeline (do this for every component)

1. **Find** a component on one of the sources that matches a need.
2. **Copy** its source into `packages/ui/src/components/<ComponentName>/`.
3. **Adapt**:
   - Replace every hardcoded color with a token from `packages/tokens`
     (CLAUDE.md rule 1 — no raw hex anywhere).
   - Strip props/variants we don't need; rename to our conventions.
   - Add a reduced-motion guard if it animates (CLAUDE.md rule 5).
   - Add TypeScript types; no `any`.
4. **Document** with a `<ComponentName>.stories.tsx` showing:
   - Default state
   - A TUM-blue variant and (where relevant) an accent variant
   - Hover / active / animated states
   - Dark-theme and light-theme rendering (both must work)
5. **Verify** in `npm run storybook` before considering it done.

A component without a story is not done. This is rule 2 in CLAUDE.md.

---

## 3. Folder convention

```
packages/ui/src/components/MagneticButton/
├── MagneticButton.tsx
├── MagneticButton.stories.tsx
├── index.ts
└── (optional) MagneticButton.test.tsx
```

Export everything through `packages/ui/src/index.ts` so apps import from `@groundtruth/ui`.

---

## 4. Story file template

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { MagneticButton } from "./MagneticButton";

const meta: Meta<typeof MagneticButton> = {
  title: "Components/MagneticButton",
  component: MagneticButton,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof MagneticButton>;

export const Default: Story = { args: { children: "Explore" } };
export const Accent: Story = { args: { children: "Scan to start", variant: "accent" } };
export const OnDark: Story = {
  args: { children: "Enter" },
  parameters: { backgrounds: { default: "dark" } },
};
```

---

## 5. First components worth building (priority order)

These map to what the kiosk/controller actually need early:

1. `Cursor` — the on-screen pointer the kiosk renders (smooth inertia follow).
2. `RevealText` — word/line staggered text reveal (from React Bits).
3. `MagneticButton` — magnetic hover (from Aceternity), used for QR/CTA prompts.
4. `SectionTransition` — the deliberate cross-section transition wrapper.
5. `NumberTicker` — animated counts for showreel stats (from Magic UI).
6. `QueueIndicator` — controller queue position display (shadcn-based, plain).
7. `TrackpadSurface` — controller full-screen touch surface emitting `dx,dy`.
8. `ProfileCard` / `TopicCard` / `ProjectCard` — content cards per the content model.

Build these in `packages/ui`, consume them in `apps/kiosk` and `apps/controller`.

---

## 6. Accessibility reminder

The flashy copy-paste libraries put accessibility on us — there's no library-level
enforcement. Every animated component we adopt must add `prefers-reduced-motion`
handling and sensible focus/aria where it's interactive. The controller especially
(runs on personal phones) must honor reduced motion.
