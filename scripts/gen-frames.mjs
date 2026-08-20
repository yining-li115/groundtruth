#!/usr/bin/env node
/**
 * Generate the story frames for the particle showreel with Gemini.
 *
 * The frames are not illustrations in their own right — each one is turned into a field of
 * 2D particles, and consecutive frames morph into one another. That puts hard constraints on
 * what makes a usable image, and they are baked into STYLE below: a black background (any
 * background texture becomes drifting noise), one clear subject held at a consistent size and
 * position (or the morph reads as the whole picture flying apart rather than evolving), and
 * crisp edges (a soft subject dissolves once it is sampled to points).
 *
 * Usage:
 *   node scripts/gen-frames.mjs <id>          one frame, by id from frames.json
 *   node scripts/gen-frames.mjs all           every frame that isn't already on disk
 *   node scripts/gen-frames.mjs all --force   regenerate everything
 *
 * The key lives outside the repo, at ~/.config/gemini/key, so it cannot be committed by
 * accident. Never print it.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "apps/kiosk/public/story");
const MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image";

/** Appended when a frame continues a previous one — the part that holds a sequence together. */
const CONTINUITY = [
  "This is one frame of a continuous animation. The camera does NOT move between frames:",
  "identical camera position, identical focal length, identical framing, and the subject stays",
  "at exactly the same size and exactly the same position in the frame as in the input image.",
  "Do not zoom, do not pan, do not re-compose, do not change the crop.",
  "Change ONLY what the instruction describes, and change it by a small increment.",
  "Everything the instruction does not mention must stay pixel-for-pixel as it was.",
].join(" ");

/**
 * Appended to every prompt.
 *
 * The first version of this asked for "one clear subject, centred, precise, technical" on
 * black, and got exactly that: sterile CAD renders with almost no tonal variation. A particle
 * field is built out of tonal variation — flat surfaces sample to flat slabs of dust and read
 * as dead. What the field needs is photographic density: texture, grain, depth, thousands of
 * small tonal differences for the sampler to find.
 */
const STYLE = [
  "Photographic, cinematic, richly detailed. Shot on a large sensor with a long lens.",
  "Dense fine texture everywhere: weathered surfaces, foliage, atmosphere, grain, dust in the air.",
  "Dramatic directional light with deep shadows and bright highlights — strong tonal range.",
  "Pure black background behind the subject, no sky gradient, no horizon line, no ground plane.",
  "The subject fills the frame edge to edge with detail; avoid large empty areas.",
  "Desaturated cool palette, near monochrome, with one restrained electric blue-violet accent.",
  "No text, no labels, no watermarks, no logos, no readable faces.",
].join(" ");

async function key() {
  const k = (await readFile(join(homedir(), ".config/gemini/key"), "utf8")).trim();
  if (!k) throw new Error("empty key file");
  return k;
}

/**
 * Chained generation. A frame with `from` is produced by handing the model the PREVIOUS
 * frame as an input image and asking for one step of the motion — which is the only way the
 * subject keeps its proportions, angle and style across a sequence. Generated independently,
 * eight "poses" drift into eight different subjects, and the particle morph between them
 * reads as the picture flying apart rather than something moving.
 */
async function generate(prompt, dest, apiKey, initPath) {
  const parts = [];
  if (initPath) {
    const bytes = await readFile(initPath);
    parts.push({ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } });
  }
  parts.push({ text: initPath ? `${prompt} ${CONTINUITY} ${STYLE}` : `${prompt} ${STYLE}` });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
      }),
    },
  );
  const json = await res.json();
  if (json.error) throw new Error(`${json.error.code} ${json.error.message}`);
  const out = json.candidates?.[0]?.content?.parts ?? [];
  const img = out.find((p) => p.inlineData)?.inlineData;
  if (!img) {
    const why = json.candidates?.[0]?.finishReason ?? "no image in response";
    throw new Error(`no image returned (${why})`);
  }
  await writeFile(dest, Buffer.from(img.data, "base64"));
  return Buffer.from(img.data, "base64").length;
}

async function main() {
  const [which, ...flags] = process.argv.slice(2);
  if (!which) throw new Error("usage: gen-frames.mjs <id|all> [--force]");
  const force = flags.includes("--force");
  const frames = JSON.parse(await readFile(join(root, "scripts/frames.json"), "utf8"));
  const apiKey = await key();
  await mkdir(OUT, { recursive: true });

  const todo = which === "all" ? frames : frames.filter((f) => f.id === which);
  if (!todo.length) throw new Error(`no frame with id "${which}"`);

  for (const f of todo) {
    const dest = join(OUT, `${f.id}.png`);
    if (existsSync(dest) && !force) {
      console.log(`skip  ${f.id} (already on disk)`);
      continue;
    }
    const init = f.from ? join(OUT, `${f.from}.png`) : null;
    if (init && !existsSync(init)) {
      console.log(`skip  ${f.id} (needs ${f.from} first)`);
      continue;
    }
    process.stdout.write(`gen   ${f.id}${init ? ` ← ${f.from}` : ""} … `);
    try {
      const bytes = await generate(f.prompt, dest, apiKey, init);
      console.log(`${(bytes / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error("gen-frames:", e.message);
  process.exit(1);
});
