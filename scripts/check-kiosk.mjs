#!/usr/bin/env node
/**
 * End-to-end check of the kiosk, in a real browser (`npm run check:kiosk`).
 *
 * The synthetic harness (`check:pointer`) proves the pointing state machine behaves. It says
 * nothing about whether the page it drives actually works — whether the camera pipeline
 * starts, whether the views render, whether the things a hand has to hit are on screen and
 * reachable. That needs a browser, and doing it by hand means standing up, waving at a
 * screen, and still not knowing which of the six views quietly threw.
 *
 * So Chrome runs headless with a FAKE camera (`--use-fake-device-for-media-stream`), which
 * makes `getUserMedia` resolve and the whole vision pipeline load and run against a synthetic
 * stream. No hands appear in a test pattern, so this cannot test tracking — it tests
 * everything around it: that nothing throws, that every view renders its controls, and that
 * navigation driven by real clicks lands where it should.
 *
 * As with the screenshot tool, Chrome is launched against a throwaway profile and killed by
 * pid, so a browser the user has open with their own tabs is never touched.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function ok(label, cond, detail = "") {
  checks += 1;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Console messages we expect and do not want counted as failures. */
const BENIGN = [
  /Feedback manager requires a model/i,
  /Using NORM_RECT without IMAGE_DIMENSIONS/i,
  /XNNPACK/i,
  /TensorFlow Lite/i,
  /GPU delegate/i,
  /Download the React DevTools/i,
  /WebGL.*deprecated/i,
];

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "kioskcheck-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1600,900",
      "--hide-scrollbars",
      "--no-first-run",
      "--enable-unsafe-swiftshader",
      // The camera. Without these the kiosk has no input at all and every check below is
      // really a check of the permission prompt.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    let ws = null;
    for (let i = 0; i < 60 && !ws; i += 1) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        ws = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
      } catch {
        /* not up yet */
      }
    }
    if (!ws) throw new Error("chrome debug endpoint never came up");

    const sock = new WebSocket(ws);
    await new Promise((res, rej) => {
      sock.onopen = res;
      sock.onerror = () => rej(new Error("debug socket failed"));
    });

    let id = 0;
    const pending = new Map();
    const problems = [];
    sock.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        problems.push(`exception: ${d?.exception?.description ?? d?.text ?? "unknown"}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (!BENIGN.some((re) => re.test(text))) problems.push(`console.error: ${text}`);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        sock.send(JSON.stringify({ id: n, method, params }));
      });

    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r?.exceptionDetails) {
        return { error: r.exceptionDetails.exception?.description ?? "threw" };
      }
      return r?.result?.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");

    const goto = async (url, waitMs = 6000) => {
      problems.length = 0;
      await send("Page.navigate", { url });
      await sleep(waitMs);
    };

    // ---------------------------------------------------------------- showreel
    console.log("\nshowreel (the idle screen, and the way in)\n");
    await goto(`${BASE}/?calibrate=0`, 9000);

    ok(
      "the camera actually started",
      (await evaluate(`!!document.querySelector('video.gt-hand-cam')?.srcObject`)) === true,
    );
    ok(
      "the vision models loaded without an error banner",
      (await evaluate(`!document.querySelector('.gt-hand-error')`)) === true,
      await evaluate(`document.querySelector('.gt-hand-error')?.textContent ?? ''`),
    );
    ok(
      "the standing invitation is shown while nobody is there",
      (await evaluate(`!!document.querySelector('.sf-invite')`)) === true,
    );
    ok(
      "the way in exists but is not offered to nobody",
      (await evaluate(
        `(() => { const e = document.querySelector('.sf-enter');
           return !!e && !e.classList.contains('is-on'); })()`,
      )) === true,
    );
    ok("no page errors on the idle screen", problems.length === 0, problems[0]);

    // Entering is a real click on the real button, the same call the hand pointer makes.
    await evaluate(`document.querySelector('.sf-enter__btn').click()`);
    await sleep(2500);
    ok(
      "clicking it enters the site",
      (await evaluate(`!!document.querySelector('.hb, [data-section-home]')`)) === true,
    );

    // ---------------------------------------------------------------- home
    console.log("\nthe home page carries the whole menu\n");
    await goto(`${BASE}/?enter=1&calibrate=0`, 5000);

    // The five colour columns became the dark board's five rows (`scenes/HomeBoard`); the
    // property being checked is unchanged — every destination stands on the home page, at a
    // size a hand can hit, and clicking one opens it.
    const rows = await evaluate(`document.querySelectorAll('.hb-row').length`);
    ok("every section stands on the home page", rows === 5, `${rows} rows`);

    const shortest = await evaluate(
      `(() => {
         const h = [...document.querySelectorAll('.hb-row')]
           .map((c) => Math.round(c.getBoundingClientRect().height));
         return Math.min(...h);
       })()`,
    );
    // These are the primary targets of the whole kiosk, aimed at by a hand from metres away.
    // Full column width already, so height is the only dimension that can be got wrong.
    ok(`the shortest row is still a big target (${shortest}px)`, shortest >= 100, `${shortest}px`);

    const arrows = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.hb-row')];
      return rows.map((row) => {
        const box = row.querySelector('.hb-row__go')?.getBoundingClientRect();
        const icon = row.querySelector('.gt-arrow-right')?.getBoundingClientRect();
        if (!box || !icon) return 999;
        return Math.hypot(
          box.left + box.width / 2 - (icon.left + icon.width / 2),
          box.top + box.height / 2 - (icon.top + icon.height / 2),
        );
      });
    })()`);
    ok(
      "every destination arrow is geometrically centred",
      Array.isArray(arrows) && arrows.length === 5 && arrows.every((d) => d <= 0.75),
      JSON.stringify(arrows),
    );

    ok(
      "the home does not also carry a menu toggle (it would be a door into this room)",
      (await evaluate(`!document.querySelector('.hb .sm-toggle')`)) === true,
    );
    ok("no page errors on the home", problems.length === 0, problems[0]);

    // A real click on a real row, the same call the hand pointer makes.
    await evaluate(`document.querySelectorAll('.hb-row')[4].click()`);
    await sleep(2500);
    ok(
      "clicking a row opens that section",
      (await evaluate(`!!document.querySelector('[data-section-home]')`)) === true,
    );

    // ---------------------------------------------------------------- sections
    console.log("\nevery section renders, and can be left again\n");
    for (const view of ["people", "research", "projects", "publications", "teaching"]) {
      await goto(`${BASE}/?view=${view}&calibrate=0`, 5000);
      // The site shell only shows once someone has come in; deep links start at the showreel.
      await evaluate(`document.querySelector('.sf-enter__btn')?.click()`);
      await sleep(2000);

      const back = await evaluate(`!!document.querySelector('[data-section-home]')`);
      // Not "has an h1": the sections were built with different layouts and some title
      // themselves in other ways. What matters is that real content arrived.
      const chars = await evaluate(`(document.body.innerText ?? '').trim().length`);
      ok(`${view}: renders content`, typeof chars === "number" && chars > 200, `${chars} chars`);
      ok(`${view}: has a reachable way back`, back === true);
      ok(`${view}: no page errors`, problems.length === 0, problems[0]);

      // The Home control must be present AND actually clickable. "Is it in the DOM" would
      // not have caught either of the two overlaps found here: a debug button pinned to the
      // same corner, and a section's own filter bar running straight through it.
      //
      // Probe the bottom-left target and the portion of it that reaches the calibrated LEFT
      // band. Calibration proves axis bands, not diagonal corners, so a corner control must
      // extend into one of those proved bands rather than require an unmeasured extreme.
      // `elementFromPoint` also catches transparent fixed layers stealing hit ownership.
      const reachable = await evaluate(
        `(() => {
           const b = document.querySelector('[data-section-home]');
           if (!b) return 'missing';
           const r = b.getBoundingClientRect();
           const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
           if (!(b.contains(hit) || hit === b)) {
             return 'covered by ' + (hit?.className || hit?.tagName);
           }
           if (Math.abs(r.left) > 1 || Math.abs(r.bottom - innerHeight) > 1) {
             return 'not anchored bottom-left';
           }
           const provedLeft = document.elementFromPoint(innerWidth * 0.10, innerHeight * 0.68);
           return b.contains(provedLeft) || provedLeft === b
             ? 'ok'
             : 'does not reach calibrated left band';
         })()`,
      );
      ok(
        `${view}: Home is uncovered, bottom-left, and intersects a calibrated side band`,
        reachable === "ok",
        String(reachable),
      );
      ok(
        `${view}: no leftover MENU toggle`,
        (await evaluate(`!document.querySelector('.sm-toggle')`)) === true,
      );

      if (back) {
        const size = await evaluate(
          `(() => { const r = document.querySelector('[data-section-home]').getBoundingClientRect();
             return Math.round(Math.min(r.width, r.height)); })()`,
        );
        // Apple's floor for a target aimed by eye is 60pt; a hand from metres away is no more
        // precise. The corner region is far past that — this is the floor, not the target, and
        // it exists so that shrinking it back to a button would fail loudly.
        ok(`${view}: the way back is big enough to hit (${size}px)`, size >= 44, `${size}px`);
      }
    }

    // ------------------------------------------------- shared Home theme follows the page
    //
    // The Home corner is white on the dark sections and brand violet on the light ones, and it
    // used to decide that once, from the section root, when `view` changed. A DETAIL view can
    // be a different theme from the section that owns it and does not change `view` at all —
    // opening a person swapped the page to a dark profile while the glow stayed violet.
    console.log("\nthe shared Home header is painted against the page it is on\n");
    {
      await goto(`${BASE}/?view=people&calibrate=0`, 5000);
      await evaluate(`document.querySelector('.sf-enter__btn')?.click()`);
      await sleep(2000);
      const onList = await evaluate(`document.querySelector('[data-section-home]')?.className ?? 'missing'`);
      ok(
        "people list gets the light ink-and-grey Home treatment",
        String(onList).includes("section-home--light"),
        String(onList),
      );

      const opened = await evaluate(`(() => {
        const card = document.querySelector('.ppl-card');
        if (!card) return 'no card';
        card.click();
        return 'clicked';
      })()`);
      await sleep(1200);
      const onDetail = await evaluate(`document.querySelector('[data-section-home]')?.className ?? 'missing'`);
      ok(
        "...and a person's dark detail flips it to the dark treatment",
        opened === "clicked" && String(onDetail).includes("section-home--dark"),
        `${opened} → ${onDetail}`,
      );
      ok(
        "person detail keeps both Home and Back-to-roster as separate targets",
        (await evaluate(
          `!!document.querySelector('[data-section-home]') && !!document.querySelector('.ppl-detail__back')`,
        )) === true,
      );

      await goto(`${BASE}/?view=teaching&enter=1&calibrate=0`, 3500);
      const teachingHome = await evaluate(`(() => {
        const home = document.querySelector('[data-section-home]');
        if (!home) return { error: 'missing' };
        const style = getComputedStyle(home);
        const probe = document.createElement('span');
        probe.style.color = 'var(--gt-accent)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const rect = home.getBoundingClientRect();
        const brand = document.querySelector('.section-layout__brandbar .section-brand')
          ?.getBoundingClientRect();
        const title = document.querySelector('.section-layout h1')?.getBoundingClientRect();
        return {
          className: home.className,
          color: style.color,
          accent,
          bottomLeft: Math.abs(rect.left) <= 1 && Math.abs(rect.bottom - innerHeight) <= 1,
          brandSeparated: !brand || !title || brand.bottom <= title.top,
        };
      })()`);
      ok(
        "Teaching Home uses the light ink/grey treatment, not the old accent colour",
        String(teachingHome?.className).includes('section-home--light') &&
          teachingHome?.color !== teachingHome?.accent,
        JSON.stringify(teachingHome),
      );
      ok(
        "Teaching keeps the top-left brand in a reserved row and Home at bottom-left",
        teachingHome?.brandSeparated === true && teachingHome?.bottomLeft === true,
        JSON.stringify(teachingHome),
      );
    }

    // ------------------------------------------- list title/hover geometry
    console.log("\npublication/project lists preserve layout while giving hand hover feedback\n");
    for (const view of ["projects", "publications"]) {
      await goto(`${BASE}/?view=${view}&enter=1&calibrate=0`, 4000);
      const listGeometry = await evaluate(`(async () => {
        const items = [...document.querySelectorAll('.menu__item')];
        const item = items.reduce((longest, candidate) =>
          (candidate.textContent?.length ?? 0) > (longest?.textContent?.length ?? 0)
            ? candidate : longest, items[0]);
        const other = items.find((candidate) => candidate !== item);
        const mask = item?.querySelector('.menu__item-text');
        const label = item?.querySelector('.menu__item-label');
        if (!item || !other || !mask || !label) return { error: 'missing list item' };
        const before = item.getBoundingClientRect();
        item.classList.add('is-hover');
        // Inspect the settled visual state, not the first two frames of the intentional 0.28s
        // transition (which correctly still report values close to 1).
        await new Promise((resolve) => setTimeout(resolve, 360));
        const after = item.getBoundingClientRect();
        const transform = getComputedStyle(label).transform;
        const popScale = transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
        const otherOpacity = Number.parseFloat(getComputedStyle(other).opacity);
        const maskRect = mask.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const titleFullyVisible = labelRect.left >= maskRect.left - 1 &&
          labelRect.right <= maskRect.right + 1 && labelRect.top >= maskRect.top - 1 &&
          labelRect.bottom <= maskRect.bottom + 1 && mask.scrollWidth <= mask.clientWidth + 1;
        item.classList.remove('is-hover');
        const title = document.querySelector('.title')?.getBoundingClientRect();
        const menu = document.querySelector('.menu')?.getBoundingClientRect();
        return {
          stable: Math.abs(before.left - after.left) < 0.5 &&
            Math.abs(before.top - after.top) < 0.5 &&
            Math.abs(before.width - after.width) < 0.5 &&
            Math.abs(before.height - after.height) < 0.5,
          clipped: getComputedStyle(mask).overflow === 'hidden',
          popScale,
          otherOpacity,
          handScrollSpeed: document.querySelector('[data-hand-scroll-speed]')
            ?.getAttribute('data-hand-scroll-speed') ?? null,
          titleFullyVisible,
          wraps: getComputedStyle(item.querySelector('.menu__item-textinner')).whiteSpace !== 'nowrap',
          titleBeforeList: !title || !menu || title.bottom <= menu.top + 1,
        };
      })()`);
      ok(
        `${view}: hover strongly pops only the label and dims the stable surrounding rows`,
        listGeometry?.stable === true &&
        listGeometry.clipped === true &&
          listGeometry.popScale >= (view === "publications" ? 1.17 : 1.1) &&
          listGeometry.otherOpacity <= 0.35 &&
          listGeometry.titleFullyVisible === true && listGeometry.wraps === true,
        JSON.stringify(listGeometry),
      );
      if (view === "publications") {
        ok(
          "publications: fist scrolling is locally slowed without changing other pages",
          Number(listGeometry?.handScrollSpeed) === 0.8,
          JSON.stringify(listGeometry),
        );
        ok(
          "publications: poster title owns layout space before the list",
          listGeometry?.titleBeforeList === true,
          JSON.stringify(listGeometry),
        );
      }
    }

    // -------------------------------------------- detail-page previous / next wings
    //
    // These are not arrow-sized controls: the hand is allowed to land anywhere in the broad
    // transparent region at the relevant edge. Keep geometry and hit-testing honest on both
    // consumers of the shared DetailPager. In particular, enlarging the left wing must not
    // steal the Home corner, and enlarging either wing must not steal a fist-scroll begun in
    // the middle of the article.
    console.log("\ndetail-page arrows have hand-sized hit regions with safe ownership\n");
    for (const view of ["projects", "publications"]) {
      await goto(`${BASE}/?view=${view}&enter=1&calibrate=0`, 4000);
      const opened = await evaluate(`(() => {
        const item = document.querySelectorAll('.menu__item')[1];
        if (!item) return false;
        item.click();
        return true;
      })()`);
      await sleep(800);

      const geometry = await evaluate(`(() => {
        const prev = document.querySelector('.dp-wing--prev');
        const next = document.querySelector('.dp-wing--next');
        if (!prev || !next) return { error: 'missing wings' };
        const pr = prev.getBoundingClientRect();
        const nr = next.getBoundingClientRect();
        const owns = (selector, x, y) =>
          !!document.elementFromPoint(x, y)?.closest(selector);
        const prevOwns = (x, y) =>
          owns('.dp-wing--prev', pr.left + pr.width * x, pr.top + pr.height * y);
        const nextOwns = (x, y) =>
          owns('.dp-wing--next', nr.right - nr.width * x, nr.top + nr.height * y);
        const sampleOwner = (x, y) => {
          const element = document.elementFromPoint(pr.left + pr.width * x, pr.top + pr.height * y);
          return element ? element.tagName + '.' + element.className : 'none';
        };
        const arrow = prev.querySelector('.dp-wing__arrow');
        const home = document.querySelector('[data-section-home]');
        const hr = home?.getBoundingClientRect();
        const homeBefore = home ? getComputedStyle(home, '::before') : null;
        const homeAfter = home ? getComputedStyle(home, '::after') : null;
        const homeLabel = home?.querySelector('.section-home__label');
        const story = document.querySelector('.detail-particle-story');
        const storySurface = story?.querySelector('canvas, [data-story-fallback]');
        const storyRect = storySurface?.getBoundingClientRect();
        prev.classList.add('gt-hover');
        const activeStyle = getComputedStyle(prev);
        const activeAfter = getComputedStyle(prev, '::after');
        const activeBefore = getComputedStyle(prev, '::before');
        const hoverInvisible =
          (activeStyle.outlineStyle === 'none' || activeStyle.outlineWidth === '0px') &&
          activeAfter.backgroundImage === 'none' && activeBefore.backgroundImage === 'none' &&
          activeAfter.borderLeftWidth === '0px' && activeAfter.borderRightWidth === '0px';
        prev.classList.remove('gt-hover');
        return {
          count: document.querySelectorAll('.dp-wing').length,
          pageNumberRemoved: !document.querySelector('.dp-count'),
          widthRatio: Math.min(pr.width, nr.width) / innerWidth,
          heightRatio: Math.min(pr.height, nr.height) / innerHeight,
          // The lower-left Home button deliberately owns the final slice of this wing. Sample
          // the still-low 76% point here, then assert Home ownership separately below.
          prevFullBody: prevOwns(0.82, 0.14) && prevOwns(0.94, 0.5) && prevOwns(0.82, 0.76),
          prevOwners: [0.14, 0.5, 0.76].map((y) => sampleOwner(y === 0.5 ? 0.94 : 0.82, y)),
          nextFullBody: nextOwns(0.82, 0.14) && nextOwns(0.94, 0.5) && nextOwns(0.82, 0.86),
          centreFree: [0.34, 0.5, 0.66].every((x) =>
            !owns('.dp-wing', innerWidth * x, innerHeight * 0.37)),
          arrowVmin: arrow
            ? parseFloat(getComputedStyle(arrow).fontSize) / Math.min(innerWidth, innerHeight)
            : 0,
          hoverInvisible,
          persistentParticleArrows:
            story?.dataset.storyParticleArrows === 'persistent',
          arrowParticleCount: Number(story?.dataset.storyArrowParticles),
          imageParticleCount: Number(story?.dataset.storyImageParticles),
          totalParticleCount: Number(story?.dataset.storyTotalParticles),
          particleEdgesFilled: story?.dataset.storySideFit === 'normalized' && !!storyRect &&
            Math.abs(storyRect.left) <= 1 && Math.abs(storyRect.right - innerWidth) <= 1 &&
            Math.abs(storyRect.width - innerWidth) <= 1,
          homeBlur: (homeBefore?.backdropFilter || homeBefore?.webkitBackdropFilter || '')
            .includes('blur('),
          homeGlowRemoved: homeAfter?.backgroundImage === 'none',
          homeLabelWhite: homeLabel ? getComputedStyle(homeLabel).color === 'rgb(255, 255, 255)' : false,
          homeWins: !!home && !!hr &&
            !!document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2)
              ?.closest('[data-section-home]'),
        };
      })()`);

      ok(`${view}: a detail opens for pager checks`, opened === true && !geometry?.error,
        String(geometry?.error ?? opened));
      ok(
        `${view}: detail keeps the particle arrows but removes the right-side page number`,
        geometry?.pageNumberRemoved === true,
        JSON.stringify(geometry),
      );
      ok(
        `${view}: pager is at least 26.5vw × 81vh`,
        geometry?.count === 2 && geometry.widthRatio >= 0.265 && geometry.heightRatio >= 0.81,
        `${Math.round((geometry?.widthRatio ?? 0) * 1000) / 10}vw × ` +
          `${Math.round((geometry?.heightRatio ?? 0) * 1000) / 10}vh`,
      );
      ok(
        `${view}: the fuller wings stay hittable high, middle and low at their inner reach`,
        geometry?.prevFullBody === true && geometry.nextFullBody === true,
        JSON.stringify(geometry),
      );
      ok(
        `${view}: dense arrows persist in the particle field without a hover outline or edge overlay`,
        geometry?.persistentParticleArrows === true &&
          geometry.arrowParticleCount >= 5760 &&
          geometry.imageParticleCount >= 64000 &&
          geometry.totalParticleCount >=
            geometry.imageParticleCount + geometry.arrowParticleCount &&
          geometry.hoverInvisible === true && geometry.arrowVmin >= 0.055,
        JSON.stringify(geometry),
      );
      ok(
        `${view}: particles reach both physical edges and Home uses a white label over local blur`,
        geometry?.particleEdgesFilled === true && geometry.homeBlur === true &&
          geometry.homeGlowRemoved === true && geometry.homeLabelWhite === true,
        JSON.stringify(geometry),
      );
      ok(
        `${view}: pager leaves a broad article-scroll corridor and Home ownership intact`,
        geometry?.centreFree === true && geometry.homeWins === true,
        JSON.stringify(geometry),
      );
    }

    // ---------------------------------------------------------------- scrolling
    console.log("\nthe pages can actually be scrolled by a drag\n");
    await goto(`${BASE}/?view=people&calibrate=0`, 5000);
    await evaluate(`document.querySelector('.sf-enter__btn')?.click()`);
    await sleep(2000);
    const scrollable = await evaluate(
      `document.documentElement.scrollHeight > window.innerHeight + 50`,
    );
    ok("a section is taller than the screen (so scrolling matters)", scrollable === true);
    const moved = await evaluate(
      `(async () => { const y0 = window.scrollY; window.scrollTo(0, 600);
         await new Promise(r => setTimeout(r, 1200)); return window.scrollY - y0; })()`,
    );
    ok("scrolling moves the page", typeof moved === "number" && moved > 100, `moved ${moved}px`);

    // ---------------------------------------------------------------- scrollable
    console.log("\nevery section has something the drag can actually scroll\n");
    for (const view of ["people", "research", "projects", "publications", "teaching"]) {
      await goto(`${BASE}/?view=${view}&enter=1&calibrate=0`, 4500);
      // A section has to be navigable by hand SOMEHOW: either the document scrolls, or
      // something under the cursor does, or it is browsed by controls (the research slider has
      // prev/next buttons). What must never happen is the case this check was written for —
      // a fixed full-screen layout whose only scroller is an inner container the gesture was
      // not addressing, where dragging silently did nothing at all.
      const target = await evaluate(
        `(() => {
           if (document.documentElement.scrollHeight > window.innerHeight + 50) return 'page';
           let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
           while (el && el !== document.body) {
             const oy = getComputedStyle(el).overflowY;
             if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 2) {
               return 'element:' + (el.className || el.tagName);
             }
             el = el.parentElement;
           }
           const handSurface = document.querySelector('[data-hand-scroll]');
           if (handSurface) return 'hand-surface:' + handSurface.getAttribute('data-hand-scroll');
           if (document.querySelector('.rsl-button, [aria-label*="ext"]')) return 'controls';
           // Nothing to scroll is fine only if there is nothing being HIDDEN. Content that
           // overflows a clipped box is content a visitor can never reach by any gesture,
           // which is a worse bug than a scroll that does not work — at least that one is
           // visible.
           const clipped = [...document.querySelectorAll('*')].find((n) => {
             const st = getComputedStyle(n);
             return (
               st.overflow === 'hidden' &&
               n.scrollHeight > n.clientHeight + 40 &&
               n.clientHeight > window.innerHeight * 0.4
             );
           });
           if (clipped) return 'CLIPPED:' + (clipped.className || clipped.tagName);
           return 'fits';
         })()`,
      );
      ok(
        `${view}: navigable by hand (${target})`,
        typeof target === "string" && !target.startsWith("CLIPPED") && target !== "none",
        String(target),
      );
    }

    // ----------------------------------------------------------- Research hand grammar
    console.log("\nResearch exposes a horizontal hand surface and non-blocking edge affordances\n");
    await goto(`${BASE}/?view=research&enter=1&calibrate=0`, 4500);
    const research = await evaluate(`(() => {
      const surface = document.querySelector('[data-hand-scroll="x"]');
      const edges = [...document.querySelectorAll('.rsl-edge')];
      const slide = document.querySelector('.rsl-slide');
      if (!surface || !slide) return { error: 'missing horizontal surface' };
      const before = getComputedStyle(slide).transform;
      surface.dispatchEvent(new CustomEvent('handscroll', {
        detail: { phase: 'press', dx: 0, dy: 0, ownerId: 41 },
      }));
      surface.dispatchEvent(new CustomEvent('handscroll', {
        detail: { phase: 'start', dx: 0, dy: 0, ownerId: 41 },
      }));
      surface.dispatchEvent(new CustomEvent('handscroll', {
        detail: { phase: 'move', dx: 320, dy: 0, ownerId: 41 },
      }));
      const after = getComputedStyle(slide).transform;
      surface.dispatchEvent(new CustomEvent('handscroll', {
        detail: { phase: 'end', dx: 0, dy: 0, ownerId: 41 },
      }));
      return {
        edges: edges.length,
        edgesDoNotStealHits: edges.every((edge) => getComputedStyle(edge).pointerEvents === 'none'),
        slidesHoverable: [...document.querySelectorAll('.rsl-slide')].every((el) => el.hasAttribute('data-hover')),
        moved: before !== after,
      };
    })()`);
    ok(
      "Research has two visual edge zones that never steal click/drag ownership",
      research?.edges === 2 && research.edgesDoNotStealHits === true,
      JSON.stringify(research),
    );
    ok(
      "Research slides expose stable hover targets and accept horizontal hand movement",
      research?.slidesHoverable === true && research.moved === true,
      JSON.stringify(research),
    );

    // ------------------------------------------ Student Project detail / particle story
    console.log("\nstudent projects reuse the paper detail system with their own five-image story\n");
    await goto(`${BASE}/?view=projects&enter=1&calibrate=0`, 4500);
    const projectDetail = await evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (predicate, timeoutMs = 12000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (predicate()) return true;
          await delay(40);
        }
        return false;
      };
      const frameUrls = [
        '/projects/story-idea.png',
        '/projects/story-prototype.png',
        '/projects/story-build.png',
        '/projects/story-test.png',
        '/projects/story-demo.png',
      ];
      const frameAssets = await Promise.all(frameUrls.map((url) => new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => resolve({ url, ok: false, reason: 'timeout' }), 8000);
        image.onload = () => {
          clearTimeout(timer);
          resolve({
            url,
            ok: image.naturalWidth > 0 && image.naturalHeight > 0,
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
        };
        image.onerror = () => {
          clearTimeout(timer);
          resolve({ url, ok: false, reason: 'load error' });
        };
        image.src = url;
      })));

      const rows = [...document.querySelectorAll('.projects .menu__item')];
      const openedIndex = 1;
      rows[openedIndex]?.click();
      const ready = await waitFor(() =>
        document.querySelector('.project-story')?.dataset.storyState === 'ready' &&
        !!document.querySelector('.project-story canvas[data-story-canvas]'));
      if (!ready) return { error: 'project particles did not become ready', frameAssets };
      await delay(100);

      const root = document.querySelector('.project-story');
      const canvas = root?.querySelector('canvas[data-story-canvas]') ?? null;
      const detail = document.querySelector('.sp-detail');
      const before = {
        index: Number(root?.dataset.storyIndex),
        frame: Number(root?.dataset.storyFrame),
        frameCount: Number(root?.dataset.storyFrameCount),
        state: root?.dataset.storyState,
        persistentArrows: root?.dataset.storyParticleArrows,
        browseHidden: getComputedStyle(document.querySelector('.projects > .menu')).visibility,
        detailBackground: getComputedStyle(detail).backgroundColor,
        detailWidth: document.querySelector('.sp-detail-inner')?.getBoundingClientRect().width ?? 0,
      };

      document.querySelector('.dp-wing--next')?.click();
      const advanced = await waitFor(() =>
        Number(document.querySelector('.project-story')?.dataset.storyIndex) === openedIndex + 1 &&
        document.querySelector('.project-story')?.dataset.storyTransition === 'morphing');
      const settled = await waitFor(() =>
        document.querySelector('.project-story')?.dataset.storyTransition === 'settled', 3000);
      const afterRoot = document.querySelector('.project-story');
      return {
        frameAssets,
        before,
        advanced,
        settled,
        afterIndex: Number(afterRoot?.dataset.storyIndex),
        afterFrame: Number(afterRoot?.dataset.storyFrame),
        sameCanvas: afterRoot === root &&
          afterRoot?.querySelector('canvas[data-story-canvas]') === canvas,
      };
    })()`);
    ok(
      "all five Student Project particle-target images decode",
      projectDetail?.frameAssets?.length === 5 &&
        projectDetail.frameAssets.every((asset) =>
          asset.ok === true && asset.width >= 1000 && asset.height >= 500) &&
        projectDetail.before?.frameCount === 5 && projectDetail.before?.state === "ready",
      JSON.stringify(projectDetail),
    );
    ok(
      "Student Project detail matches Paper's transparent centred reading surface",
      projectDetail?.before?.browseHidden === "hidden" &&
        projectDetail.before.detailBackground === "rgba(0, 0, 0, 0)" &&
        projectDetail.before.detailWidth <= 1600 * 0.49,
      JSON.stringify(projectDetail?.before),
    );
    ok(
      "Student Project keeps persistent particle arrows and morphs the same canvas on Next",
      projectDetail?.before?.persistentArrows === "persistent" &&
        projectDetail.advanced === true && projectDetail.settled === true &&
        projectDetail.sameCanvas === true &&
        projectDetail.afterIndex === projectDetail.before.index + 1 &&
        projectDetail.afterFrame ===
          (projectDetail.before.frame + 1) % projectDetail.before.frameCount,
      JSON.stringify(projectDetail),
    );
    ok("no page errors during the Student Project story", problems.length === 0, problems[0]);

    // ---------------------------------------------- Publication detail / particle story
    console.log("\npublication opens on its list, then reforms one cloud through five image targets\n");

    // A genuine direct link may open a paper. Once the visitor leaves it, however, `open` is
    // history rather than navigation state: Home → Publications must return to the shelf.
    await goto(`${BASE}/?view=publications&open=dynsup&enter=1&calibrate=0`, 4500);
    const directPaperOpened = await evaluate(`!!document.querySelector('.pub-detail')`);
    await evaluate(`document.querySelector('[data-section-home]')?.click()`);
    await sleep(1800);
    await evaluate(`
      [...document.querySelectorAll('.hb-row')]
        .find((row) => /Publications/i.test(row.textContent ?? ''))?.click()
    `);
    await sleep(1800);
    const cleanReentry = await evaluate(`({
      list: !!document.querySelector('.publications > .menu'),
      detail: !!document.querySelector('.pub-detail'),
      open: new URLSearchParams(location.search).get('open'),
    })`);
    ok(
      "leaving a paper clears its deep-link so Home → Publications returns to the list",
      directPaperOpened === true && cleanReentry?.list === true &&
        cleanReentry.detail === false && cleanReentry.open === null,
      JSON.stringify({ directPaperOpened, cleanReentry }),
    );

    await goto(`${BASE}/?view=publications&enter=1&calibrate=0`, 4500);
    const publicationDetail = await evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (predicate, timeoutMs = 12000) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (predicate()) return true;
          await delay(40);
        }
        return false;
      };
      const frameUrls = [
        '/publications/story-act-capture.png',
        '/publications/story-act-reconstruct.png',
        '/publications/story-act-understand.png',
        '/publications/story-act-action.png',
        '/publications/story-act-observe.png',
      ];
      // Decode every target in this browser. The WebGL field samples these exact pixels, so a
      // data attribute alone cannot prove that the source material is actually usable.
      const frameAssets = await Promise.all(frameUrls.map((url) => new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => resolve({ url, ok: false, reason: 'timeout' }), 8000);
        image.onload = () => {
          clearTimeout(timer);
          resolve({
            url,
            ok: image.naturalWidth > 0 && image.naturalHeight > 0,
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
        };
        image.onerror = () => {
          clearTimeout(timer);
          resolve({ url, ok: false, reason: 'load error' });
        };
        image.src = url;
      })));

      const listOnEntry = {
        detailAbsent: !document.querySelector('.pub-detail'),
        menuVisible: getComputedStyle(document.querySelector('.publications > .menu')).visibility,
      };

      // Start far enough from both ends to exercise next, previous and the five-frame loop.
      const rows = [...document.querySelectorAll('.menu__item')];
      const withImage = rows.find((row, index) =>
        index > 0 && index < rows.length - 6 && row.dataset.hasImage === 'true');
      if (!withImage) return { error: 'no interior paper row', frameAssets, listOnEntry };
      const openedIndex = rows.indexOf(withImage);
      withImage.click();
      const ready = await waitFor(() =>
        document.querySelector('.publication-story')?.dataset.storyState === 'ready' &&
        !!document.querySelector('.publication-story canvas[data-story-canvas]'));
      if (!ready) return {
        error: 'publication particles did not become ready', frameAssets, listOnEntry,
      };
      await delay(100);

      const root = document.querySelector('.publication-story');
      const canvas = root?.querySelector('canvas[data-story-canvas]') ?? null;
      const snapshot = () => {
        const story = document.querySelector('.publication-story');
        const field = story?.querySelector('canvas[data-story-canvas]') ?? null;
        const fieldStyle = field ? getComputedStyle(field) : null;
        const rect = field?.getBoundingClientRect();
        return {
          index: Number(story?.dataset.storyIndex),
          frame: Number(story?.dataset.storyFrame),
          frameCount: Number(story?.dataset.storyFrameCount),
          state: story?.dataset.storyState ?? null,
          transition: story?.dataset.storyTransition ?? null,
          visible: !!rect && rect.width > 0 && rect.height > 0 &&
            fieldStyle?.display !== 'none' && fieldStyle?.visibility !== 'hidden' &&
            Number.parseFloat(fieldStyle?.opacity ?? '0') > 0.5,
          canvasWidth: field?.width ?? 0,
          canvasHeight: field?.height ?? 0,
          cssWidth: rect?.width ?? 0,
          cssHeight: rect?.height ?? 0,
          fallbackGone: !story?.querySelector('[data-story-fallback]'),
        };
      };
      const initial = snapshot();

      const qr = document.querySelector('.pub-paper-qr');
      const detail = document.querySelector('.pub-detail-inner');
      const detailRect = detail?.getBoundingClientRect();
      const centreHit = detailRect
        ? document.elementFromPoint(
            detailRect.left + detailRect.width / 2,
            Math.min(Math.max(detailRect.top + detailRect.height * 0.28, 1), innerHeight - 1),
          )
        : null;
      const storyMask = root
        ? (getComputedStyle(root).maskImage || getComputedStyle(root).webkitMaskImage)
        : '';
      const centreSafe = !!root &&
        !!centreHit &&
        getComputedStyle(root).pointerEvents === 'none' &&
        !centreHit.closest('.publication-story') &&
        storyMask.includes('27%') && storyMask.includes('73%');

      // Every adjacent paper must target a genuinely different image-derived particle shape.
      document.querySelector('.dp-wing--next')?.click();
      const nextAdvanced = await waitFor(() =>
        Number(document.querySelector('.publication-story')?.dataset.storyIndex) === openedIndex + 1 &&
        document.querySelector('.publication-story')?.dataset.storyTransition === 'morphing');
      const duringNext = snapshot();
      const nextSettled = await waitFor(() =>
        document.querySelector('.publication-story')?.dataset.storyTransition === 'settled', 3000);
      const nextRoot = document.querySelector('.publication-story');
      const next = snapshot();

      document.querySelector('.dp-wing--prev')?.click();
      const previousReturned = await waitFor(() =>
        Number(document.querySelector('.publication-story')?.dataset.storyIndex) === openedIndex &&
        document.querySelector('.publication-story')?.dataset.storyTransition === 'morphing');
      const duringPrevious = snapshot();
      const previousSettled = await waitFor(() =>
        document.querySelector('.publication-story')?.dataset.storyTransition === 'settled', 3000);
      const returnedRoot = document.querySelector('.publication-story');
      const returned = snapshot();

      // Five papers later the authored sequence is reused, without replacing the WebGL field.
      rows[openedIndex + 5]?.click();
      const loopTargeted = await waitFor(() =>
        Number(document.querySelector('.publication-story')?.dataset.storyIndex) === openedIndex + 5);
      const loopSettled = await waitFor(() =>
        document.querySelector('.publication-story')?.dataset.storyTransition === 'settled', 3000);
      const looped = snapshot();

      return {
        qr: qr?.tagName?.toLowerCase() ?? null,
        qrTitle: qr?.querySelector('title')?.textContent ?? '',
        image: !!document.querySelector('.pub-detail-image'),
        abstract: !!document.querySelector('.pub-detail-abstract'),
        abstractFirst: document.querySelector('.pub-detail-body')?.firstElementChild
          ?.classList.contains('pub-detail-abstract') === true,
        factsDirection: getComputedStyle(document.querySelector('.pub-meta-facts')).flexDirection,
        browseHidden: getComputedStyle(document.querySelector('.publications > .menu')).visibility,
        listOnEntry,
        frameAssets,
        initial,
        duringNext,
        next,
        returned,
        nextAdvanced,
        nextSettled,
        previousReturned,
        previousSettled,
        duringPrevious,
        sameCanvasReused: nextRoot === root && returnedRoot === root &&
          nextRoot?.querySelector('canvas[data-story-canvas]') === canvas &&
          returnedRoot?.querySelector('canvas[data-story-canvas]') === canvas,
        centreSafe,
        storyMask,
        loopTargeted,
        loopSettled,
        looped,
        loopCanvasReused: document.querySelector(
          '.publication-story canvas[data-story-canvas]') === canvas,
      };
    })()`);
    ok(
      "Publication section entry shows the paper list before any detail",
      publicationDetail?.listOnEntry?.detailAbsent === true &&
        publicationDetail.listOnEntry.menuVisible === "visible",
      JSON.stringify(publicationDetail?.listOnEntry),
    );
    ok(
      "publication replaces the external-link label with an accessible generated SVG QR",
      publicationDetail?.qr === "svg" && /scan to read/i.test(publicationDetail.qrTitle),
      JSON.stringify(publicationDetail),
    );
    ok(
      "publication detail keeps its abstract and shows its featured figure when available",
      publicationDetail?.abstract === true &&
        publicationDetail.abstractFirst === true &&
        publicationDetail.image === true,
      JSON.stringify(publicationDetail),
    );
    ok(
      "publication stacks Venue/Year beside QR without browse-page ghosting",
      publicationDetail?.factsDirection === "column" &&
        publicationDetail.browseHidden === "hidden",
      JSON.stringify(publicationDetail),
    );
    ok(
      "all five authored particle-target images decode",
      publicationDetail?.frameAssets?.length === 5 &&
        publicationDetail.frameAssets.every((asset) =>
          asset.ok === true && asset.width >= 1000 && asset.height >= 500) &&
        publicationDetail.initial?.frameCount === 5 &&
        publicationDetail.initial?.state === "ready",
      JSON.stringify({
        assets: publicationDetail?.frameAssets,
        initial: publicationDetail?.initial,
      }),
    );
    ok(
      "publication replaces loading art with one visible capped-resolution particle canvas",
      publicationDetail?.initial?.fallbackGone === true &&
        publicationDetail.initial.visible === true &&
        publicationDetail.initial.canvasWidth <= publicationDetail.initial.cssWidth * 1.36 + 2 &&
        publicationDetail.initial.canvasHeight <= publicationDetail.initial.cssHeight * 1.36 + 2,
      JSON.stringify(publicationDetail?.initial),
    );
    ok(
      "Next keeps one canvas and morphs to the next image-derived particle target",
      publicationDetail?.nextAdvanced === true &&
        publicationDetail.nextSettled === true &&
        publicationDetail.sameCanvasReused === true &&
        publicationDetail.next?.index === publicationDetail.initial?.index + 1 &&
        publicationDetail.duringNext?.frame ===
          (publicationDetail.initial?.frame + 1) % publicationDetail.initial?.frameCount &&
        publicationDetail.duringNext?.transition === "morphing" &&
        publicationDetail.next?.transition === "settled",
      JSON.stringify({
        initial: publicationDetail?.initial,
        during: publicationDetail?.duringNext,
        next: publicationDetail?.next,
      }),
    );
    ok(
      "Previous reverses the same particle field back to the original target",
      publicationDetail?.previousReturned === true &&
        publicationDetail.previousSettled === true &&
        publicationDetail.returned?.index === publicationDetail.initial?.index &&
        publicationDetail.returned?.frame === publicationDetail.initial?.frame &&
        publicationDetail.duringPrevious?.transition === "morphing" &&
        publicationDetail.returned?.transition === "settled",
      JSON.stringify({
        initial: publicationDetail?.initial,
        during: publicationDetail?.duringPrevious,
        returned: publicationDetail?.returned,
      }),
    );
    ok(
      "the five particle targets loop and reuse the same field",
      publicationDetail?.loopTargeted === true &&
        publicationDetail.loopSettled === true &&
        publicationDetail.loopCanvasReused === true &&
        publicationDetail.looped?.frame === publicationDetail.initial?.frame &&
        publicationDetail.looped?.index === publicationDetail.initial?.index + 5,
      JSON.stringify({ initial: publicationDetail?.initial, looped: publicationDetail?.looped }),
    );
    ok(
      "the particle story leaves the central reading/interaction corridor untouched",
      publicationDetail?.centreSafe === true,
      String(publicationDetail?.storyMask ?? publicationDetail?.error ?? "missing"),
    );
    await sleep(250);
    ok("no page errors during the particle-story journey", problems.length === 0, problems[0]);

    // ---------------------------------------------------------------- experiments
    console.log("\nthe tuning pages still work\n");
    for (const exp of ["handlab", "pointer"]) {
      await goto(`${BASE}/?exp=${exp}&calibrate=0`, 7000);
      ok(`/?exp=${exp}: renders`, (await evaluate(`document.body.children.length > 0`)) === true);
      ok(`/?exp=${exp}: no page errors`, problems.length === 0, problems[0]);
    }

    sock.close();
  } finally {
    chrome.kill("SIGTERM"); // this pid only — never a broad pkill
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} passed\n`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error("check-kiosk:", e.message);
  process.exit(1);
});
