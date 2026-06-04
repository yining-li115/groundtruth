# Roadmap

Build order is "make it work, then make it cool." Each phase is a coherent chunk Claude
Code can take on. Check items off as they land; update CLAUDE.md §7 when an open
decision resolves.

---

## Phase 0 — Foundation
- [x] Monorepo scaffold: `apps/kiosk`, `apps/controller`, `apps/relay`, `packages/ui`,
      `packages/tokens`, `packages/protocol`, `content/` (per CLAUDE.md §4). npm
      workspaces.
- [x] Install the locked stack (CLAUDE.md §3). No extras. (React 19, Vite 8,
      Storybook 10, Tailwind v4, R3F 9, gsap/lenis/zustand/framer-motion,
      socket.io/-client, tsx for the relay.)
- [x] `packages/tokens`: encode all colors from `docs/design-system.md` as TS constants
      (`palette`, `themes`) + CSS variables (`tokens.css`, `--gt-*`). `theme.light` is
      the default at `:root`; `theme.dark` is the optional idle backdrop at
      `[data-theme="dark"]` — same token names in both.
- [x] Shared protocol types file: `packages/protocol` (per `docs/architecture.md` §5),
      imported by relay, kiosk, controller.
- [x] Storybook initialized in `packages/ui` with light + dark backgrounds configured.
- [x] Logo wired in from `assets/logo/` as a `<Logo>` component (inline SVG; `variant`
      gives the white-recolor path for dark). Story renders on light + dark.
- [x] Node version pinned: `.nvmrc` → `22` and root `package.json` `engines`
      (`node >=22`, `npm >=10`). Node 22 is the active LTS line the whole stack was
      installed and verified on; `nvm use` keeps every machine on it.

## Phase 1 — Communication backbone (do this BEFORE anything pretty)
This is the project's only make-or-break risk. Prove it first.
- [x] `apps/relay`: socket.io server (`RoomManager`), room-by-sessionId, token queue
      state machine (`docs/architecture.md` §3), driver-only input forwarding, idle /
      pass / disconnect release, per-driver input rate-limit (§9).
- [x] `apps/kiosk`: connect + register room (`kiosk:hello`), static QR (`qrcode.react`),
      inertia cursor driven by forwarded `dx,dy`/tap/scroll; idle ↔ interactive via
      `room:driverChanged`.
- [x] `apps/controller`: opens via `/c/:sessionId` (manual parse, no router),
      `TrackpadSurface` (relative `dx,dy` + tap + two-finger scroll, rAF-coalesced),
      driver/queued/passed UI, pass + idle countdown + heartbeat. Honors reduced motion.
- [x] State-machine verified by a scripted end-to-end smoke test (kiosk + 2 controllers):
      driver assignment, queue, queued-input rejection, pass→promotion (`youAreUp`),
      disconnect→idle. All 11 assertions pass.
- [x] Real-phone E2E on the **same Wi-Fi (LAN)** PASSED — driver/queue/pass verified on
      actual devices.
- [ ] **Cross-network E2E (phone on 4G, kiosk on eduroam)** — still blocked on the relay
      deployment decision (CLAUDE.md §7): needs a public deploy target + domain for the
      QR URL. Deferred by choice until the content structure lands.

## Phase 2 — Content structure
- [x] Content schema (`content/schema.ts`, zod + inferred types) + `content/*.json`
      placeholder data (2–3 realistic items each: People, Research topics, Student
      projects, Teaching, showreel) + `content/media/` folders. No standalone Photo
      gallery — photos folded into People (`photo` + `photos[]`). Avatars via DiceBear
      URLs, detail photos via picsum.
- [x] `npm run check:content` validator (zod-based) — schema + duplicate-id + dangling
      cross-ref + non-URL media-existence checks; exits non-zero on failure. (Wired to
      the npm script; **CI hookup still TODO** — no CI configured yet.)
- [x] Four browsable sections in `apps/kiosk/src/scenes`: People, Research, Student
      projects, Teaching — plain token-styled lists rendering `content/*.json` (id refs
      resolved to names). Navigated via zustand view-state (no router).
- [x] **Interactive home (landing) + horizontal navigation menu** — the post-takeover
      website shell that holds the sections (`docs/architecture.md` §6). Brand top-left,
      motto headline, 4-item horizontal nav top-right, clean central placeholder block
      (reserved for an interactive component, NOT the showreel), bottom control hint.
      Logo / controller "back" → home.
- [ ] Idle showreel as its own auto-playing standby screen (independent of home; may
      reuse the same content JSON as source material) — `docs/architecture.md` §6.
- [ ] Idle ↔ interactive mode switching driven by `room:driverChanged`. (NOT done yet:
      the website shell currently renders regardless of driver so it's directly
      previewable; the showreel + gating land with the item above.)
- [x] `PROJECT-MAP.md` at repo root — plain-language (Chinese) guide to where each kind
      of thing lives, so a non-programmer can find what to edit.

## Phase 3 — Component library (ongoing, starts here)
- [ ] Build the priority components (`docs/component-library.md` §5), each with a story.
- [ ] Migrate ad-hoc UI from phases 1–2 into `packages/ui` as it stabilizes.

## Phase 4 — WebGL façade
- [ ] Pick 1–2 hero scenes for R3F. Strong candidate: an interactive **point cloud**
      (on-brand for a remote-sensing group) as the idle-showreel backdrop.
- [ ] Postprocessing pass (bloom/DOF) for the Lusion look, perf-budgeted for the kiosk
      hardware.
- [ ] Keep navigation fully functional without the WebGL layer (CLAUDE.md rule 6).
- [ ] CANDIDATE: glass-material treatment (React Bits "Fluid Glass", R3F
      `MeshTransmissionMaterial`) for the navigation menu. Re-implement with TUM tokens,
      not pasted as-is (CLAUDE.md rule 9); needs a `.glb` model asset; perf-budget it.
      CAUTION on the cursor: a refracting/chromatic-aberration material can hurt cursor
      legibility and follow feel — the cursor's job is to be clear and tracked. Test
      before committing; readability wins over flash.

## Phase 5 — Waiting game + polish
- [ ] Endless-runner mini-game in the controller queued state.
- [ ] Transitions, sound (optional), reconnect/edge-case hardening
      (`docs/architecture.md` §8).
- [ ] Reduced-motion audit on the controller.
- [ ] Real content swap-in.

---

## Pending decisions (mirror of CLAUDE.md §7)
- [x] Dark/light palette — RESOLVED: light-first, no landing page (design-system §5).
- [ ] Relay deployment target + domain for the QR URL.
- [ ] Real content + media assets.
- [x] Web font — RESOLVED: **TUM Neue Helvetica** (official TUM identity font), wired
      as `--font-sans` in `packages/tokens`; WOFF2 in `packages/tokens/src/fonts/`,
      source TTFs in `assets/fonts/`. See design-system §4.
