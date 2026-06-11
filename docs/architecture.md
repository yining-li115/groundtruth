# Architecture

The system is three parts that all connect to one cloud relay server over WebSocket.
This doc is the contract for the relay server and both clients. The message protocol
here is normative — implement it exactly, and put the TypeScript types in a single
shared file (`packages/tokens/../protocol.ts` or `packages/protocol/`) imported by
relay, kiosk, and controller so they can never drift.

---

## 1. The three parts

```
   ┌─────────────────────┐         ┌──────────────────────┐
   │  KIOSK (big screen)  │         │ CONTROLLER (phone)   │
   │  apps/kiosk          │         │ apps/controller      │
   │  - idle showreel     │         │ - trackpad surface   │
   │  - interactive mode  │         │ - waiting room+game  │
   │  - renders cursor    │         │ - sends touch deltas │
   │  - shows static QR   │         │ - no app install     │
   └──────────┬──────────-┘         └──────────┬───────────┘
              │  WebSocket (socket.io)          │
              │                                 │
              └──────────────┬──────────────────┘
                             ▼
                  ┌──────────────────────┐
                  │  RELAY (apps/relay)   │
                  │  Node + socket.io     │
                  │  - rooms by session   │
                  │  - token queue        │
                  │  - forwards input     │
                  └──────────────────────┘
```

Why a cloud relay (not phone↔screen direct): the deployment must work whether the
phone is on **eduroam** or on the visitor's **4G/5G**. P2P / local-network tricks
fail across these boundaries (campus firewalls, NAT). A public relay both can reach
is the only approach that works in all cases. Both clients just need internet.

---

## 2. Sessions, rooms, and the QR code

- The kiosk has a stable `sessionId` (e.g. `gt-entrance` or a short code like `a7f3`).
  It is long-lived — the QR code can be **static** and printed/displayed permanently.
- On boot, the kiosk connects to the relay and joins/creates its room (`sessionId`).
- The QR code encodes `https://<domain>/c/<sessionId>` → opens the controller web app
  pointed at that room.
- A phone opening that URL connects to the relay and joins the same room.

---

## 3. The token (who is driving)

Exactly **one** controller in a room holds the **token** at a time — the "driver".
The relay is the sole authority. Clients NEVER decide locally who drives.

### Queue state machine (per room, on the relay)

```
Phone joins room
      │
      ▼
Is there a current driver?
      ├── No  → assign token → role = DRIVER
      └── Yes → push to queue → role = QUEUED (position = queue length)

Token releases when the driver:
   - taps "pass control", OR
   - is idle past IDLE_TIMEOUT (e.g. 60s no input), OR
   - disconnects (socket drop / closes tab)

On release:
      │
      ▼
Queue empty?
      ├── Yes → room has no driver → kiosk returns to idle showreel
      └── No  → pop next queued phone → role = DRIVER → notify everyone of new positions
```

Constants (define in one place, tune later): `IDLE_TIMEOUT = 60s`,
`PASS_GRACE = 0s`, max queue length optional.

---

## 4. Trackpad input model

The phone is a **relative** pointing device, like a laptop trackpad — NOT an absolute
touchscreen mapping. This is critical: the cursor moves by the *delta* of the finger,
so the small phone surface can drive the whole big screen, and the cursor never jumps.

- On `touchmove`, the controller computes `(dx, dy)` since the last touch point and
  sends it. The relay forwards to the kiosk. The kiosk moves its virtual cursor by
  `(dx, dy) * SENSITIVITY` (with smoothing/inertia — see design-system motion).
- A short tap with no movement = `click` at current cursor position.
- Two-finger drag = `scroll`, with **natural (phone-native) direction**: two fingers up
  moves content up → the page scrolls **down**. The protocol `dy` is the raw finger
  delta (down = positive); the kiosk negates it when applying `window.scrollBy`.
- Long-press / dedicated button = `back` / section exit (define in controller UX).

The kiosk owns the cursor position. The controller is "blind" — it just streams
intent. This keeps the phone simple and the screen authoritative.

**Cursor-steered hero (home only).** While the home hero is pinned, the kiosk's cursor
doubles as a view control: moving it orbits the point-cloud hero toward the cursor
(drag-to-look). This needs **no extra gesture** — the cursor stays a normal, clickable
cursor (so the MENU button is always reachable), and the orbit is just a side effect of
its position. The phone is a trackpad and never reaches the canvas's `OrbitControls`
directly (that's a desktop/dev affordance only). See `apps/kiosk/src/lib/heroInput.ts`.

**Cursor-following garnishes.** `Cursor.tsx` publishes its smoothed position each frame to a
shared singleton (`apps/kiosk/src/lib/cursorPosition.ts`) so decorative effects can follow the
SAME kiosk pointer without re-deriving it. `activePointer()` returns a real mouse while it moves
(desktop dev) else the phone-driven cursor (kiosk) — used by the home cursor-fluid garnish
(`experiments/liquid/LiquidEther.tsx`).

---

## 5. Message protocol (normative)

All messages are JSON. Define these as discriminated-union TS types in the shared
protocol file. Names are fixed.

### Client → Relay

| Type | From | Payload | Meaning |
|------|------|---------|---------|
| `kiosk:hello`      | kiosk      | `{ sessionId }` | kiosk registers its room |
| `ctrl:join`        | controller | `{ sessionId }` | phone joins a room |
| `ctrl:input.move`  | controller (driver) | `{ dx, dy }` | relative cursor delta |
| `ctrl:input.tap`   | controller (driver) | `{}` | click at cursor |
| `ctrl:input.scroll`| controller (driver) | `{ dy }` | scroll |
| `ctrl:input.back`  | controller (driver) | `{}` | go back / exit section |
| `ctrl:pass`        | controller (driver) | `{}` | voluntarily release token |
| `ctrl:heartbeat`   | controller | `{}` | connection keep-alive (does NOT reset the idle timer — see below) |

### Relay → Clients

| Type | To | Payload | Meaning |
|------|----|---------|---------|
| `room:role`        | one controller | `{ role: 'driver' \| 'queued', position? }` | assigned role |
| `room:queue`       | all controllers | `{ position, total }` | queue positions changed |
| `room:driverChanged` | kiosk | `{ hasDriver: boolean }` | enter/exit interactive mode |
| `kiosk:cursor.move`  | kiosk | `{ dx, dy }` | forwarded movement |
| `kiosk:cursor.tap`   | kiosk | `{}` | forwarded click |
| `kiosk:cursor.scroll`| kiosk | `{ dy }` | forwarded scroll |
| `kiosk:cursor.back`  | kiosk | `{}` | forwarded back |
| `room:youAreUp`      | one controller | `{}` | you just became driver (switch UI from game→trackpad) |

### Lifecycle rules
- Relay validates that input messages come from the current driver; ignore input from
  queued phones (defense against tampering).
- **Only real input** (`ctrl:input.move`/`.tap`/`.scroll`/`.back`) resets the driver's
  inactivity timer. `ctrl:heartbeat` is connection keep-alive **only** — it must NOT
  reset the idle timer, otherwise an inattentive driver who keeps the tab open would
  never time out and the queue could never reclaim the token. (Resolved in Phase 1; the
  idle release in §3 is about *no input*, and socket.io already detects dead sockets.)
- On any disconnect, relay re-runs the queue state machine (§3).
- socket.io handles reconnection; on reconnect a controller re-sends `ctrl:join` and
  the relay restores or re-queues it.

---

## 6. Kiosk modes

- **Idle / attract**: no driver in room. The **showreel** auto-plays — spotlight, news,
  open topics — with smooth, deliberate transitions. Static QR visible in a corner at
  all times. (Theme: light by default per design-system §5; optional dark backdrop.)
- **Interactive**: a driver exists (`room:driverChanged hasDriver=true`). The kiosk now
  behaves like a **normal website** (this is the Lusion post-entry feel):
  - An **interactive home (landing)** — the first screen after takeover. Big display
    headline (the group motto "Making Machines See and Think in 3D") over a full-bleed
    **WebGL point-cloud hero** (the "interaction showcase": a remote-sensing digital-twin
    of a city + satellites + car, assembled from particles). Scrolling disperses the
    particles and releases into the content feed below; the cursor orbits the cloud (§4).
    This is NOT the idle showreel — it's the home's own hero.
  - A **navigation menu** implemented as **`StaggeredMenu`** (`packages/ui`): a collapsed
    **"MENU" button** in the corner that opens a **side drawer** with the four sections
    (People, Research topics, Student projects, Teaching), each numbered 01–04. (Earlier
    drafts of this doc specified a horizontal row; the build settled on the drawer — this
    is the recorded decision.)
  - The four content sections themselves, browsed via the cursor.
  - **Section navigation runs through a pixel page transition** (`lib/navigate` →
    `lib/pixelTransition` + `components/PixelOverlay`): a full-screen grid of cells covers the
    screen, the view (zustand `view` state) swaps behind the cover, then the cells reveal the new
    page. The menu, the back-to-home button, and the controller `back` all route through
    `navigate()`. Reduced motion skips straight to the swap.
- Transition back to idle when the room loses its driver and the queue is empty, OR
  after a global inactivity timeout.

### Showreel and home are independent (content data is shared, presentation is not)
The **idle showreel** is its own thing: the screen the kiosk auto-plays when no one is
driving. The **interactive home** is a separate screen with its own layout (headline +
horizontal menu + a central interactive component). They are **built independently** —
there is no shared "mode-switching" component.

What they *may* share is **source material**, not presentation: a given research
highlight, image, or blurb might be used both in the showreel rotation and somewhere in
the home/sections. That reuse happens the normal way — both read from the same content
JSON (`content/showreel.json`, `people.json`, etc.). This is just the usual benefit of
content-as-data; it requires no special binding, no `mode` prop, and no obligation to
keep the two presentations looking alike. Each decides its own look independently.

---

## 7. Controller modes

- **Connecting**: just opened, joining room.
- **Driver**: full-screen trackpad surface + "pass control" button + a subtle timer
  showing idle countdown. Honors `prefers-reduced-motion`.
- **Queued**: shows queue position + the waiting-room **mini-game** (a simple
  endless-runner, Chrome-dino style). On `room:youAreUp`, swap to driver UI.

---

## 8. Failure / edge cases to handle

- Driver closes tab mid-session → disconnect → token passes to next or kiosk idles.
- Two phones scan within milliseconds → relay assigns first to arrive; queue is
  ordered by relay receipt time, not client clock.
- Phone loses network briefly → socket.io reconnect; relay keeps their queue slot for
  a short grace window, else re-queues.
- Relay restarts → all clients reconnect; kiosk re-registers room, controllers re-join.
- No internet on kiosk → kiosk shows a friendly "offline" state but still runs the
  idle showreel locally (showreel content should be bundled/cached, not relay-fed).

---

## 9. Security / safety notes

- The relay forwards only abstract input intents (deltas, taps). The phone can never
  execute arbitrary actions on the kiosk — it can only move a cursor and click within
  the kiosk's own UI. Keep it that way.
- Rate-limit input messages on the relay (cap messages/sec per driver).
- No personal data is collected from phones. The controller needs no login.
