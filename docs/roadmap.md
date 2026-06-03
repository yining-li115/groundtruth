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
- [ ] Content schema + `content/*.json` placeholder data + `content/media/` folders
      (per `docs/content-model.md`).
- [ ] `npm run check:content` validator (zod-based) wired up + run in CI.
- [ ] Five browsable sections in `apps/kiosk/src/scenes`: People, Research, Student
      projects, Teaching, Photo.
- [ ] Idle showreel auto-scroll (spotlight / news / open topics) with bundled content.
- [ ] Idle ↔ interactive mode switching driven by `room:driverChanged`.

## Phase 3 — Component library (ongoing, starts here)
- [ ] Build the priority components (`docs/component-library.md` §5), each with a story.
- [ ] Migrate ad-hoc UI from phases 1–2 into `packages/ui` as it stabilizes.

## Phase 4 — WebGL façade
- [ ] Pick 1–2 hero scenes for R3F. Strong candidate: an interactive **point cloud**
      (on-brand for a remote-sensing group) as the idle-showreel backdrop.
- [ ] Postprocessing pass (bloom/DOF) for the Lusion look, perf-budgeted for the kiosk
      hardware.
- [ ] Keep navigation fully functional without the WebGL layer (CLAUDE.md rule 6).

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
- [ ] Web font / typeface license.
