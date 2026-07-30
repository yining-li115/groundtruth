#!/usr/bin/env node
/**
 * Put MediaPipe's runtime and models under the kiosk's own origin.
 *
 * The vision code loaded them from public CDNs, which is fine while iterating and wrong for a
 * screen behind glass on a university network: a blocked or throttled CDN doesn't fail
 * loudly, it just means nobody's hand is ever tracked and the wall looks broken for no
 * visible reason (architecture §8 — the kiosk has to work offline).
 *
 * The WASM comes out of node_modules, so it moves in lockstep with the pinned
 * @mediapipe/tasks-vision version — a runtime/API mismatch throws at load. The .task models
 * aren't packaged anywhere, so those are fetched once and cached.
 *
 * Output is derived, and git-ignored: `npm run fetch:mediapipe` rebuilds it, and dev/build
 * run it automatically.
 */
import { createRequire } from "node:module";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "apps/kiosk/public/mediapipe");

const MODELS = [
  {
    file: "gesture_recognizer.task",
    url: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  },
  {
    file: "blaze_face_short_range.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  },
];

const exists = (p) =>
  stat(p).then(
    (s) => s.size > 0,
    () => false,
  );

async function main() {
  await mkdir(join(OUT, "models"), { recursive: true });

  // WASM: copy from the installed package rather than a CDN, so it can never drift out of
  // step with the JS API it has to match. Resolved via the package's own export (it does not
  // expose ./package.json, so require.resolve on that path throws).
  const pkg = dirname(require.resolve("@mediapipe/tasks-vision"));
  await cp(join(pkg, "wasm"), join(OUT, "wasm"), { recursive: true });
  console.log("mediapipe: wasm runtime copied from node_modules");

  for (const { file, url } of MODELS) {
    const dest = join(OUT, "models", file);
    if (await exists(dest)) {
      console.log(`mediapipe: ${file} already present`);
      continue;
    }
    process.stdout.write(`mediapipe: fetching ${file}… `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log(`mediapipe: ready under ${OUT.replace(root + "/", "")}`);
}

main().catch((e) => {
  console.error("mediapipe: FAILED —", e.message);
  console.error("  the kiosk will fall back to the CDN, which needs a working internet link");
  process.exit(1);
});
