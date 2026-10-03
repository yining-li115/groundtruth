/**
 * TypeShuffle — a faithful TypeScript port of Codrops' TypeShuffleAnimation, **effect 5**
 * only (github.com/codrops/TypeShuffleAnimation, MIT). Used by the People detail page to
 * "decode" a person's profile on entry: each visual line clears, then fills left→right as
 * characters slide in through a green→blue scramble, cascading top to bottom.
 *
 * Differences from upstream, by design (same spirit as our GlitchText, which reimplements
 * a Codrops effect without SplitType):
 *  - No Splitting.js dependency (not in our locked stack). We do our own word/char split
 *    and detect visual lines by `getBoundingClientRect().top`, so wrapping is handled.
 *  - The resting text color is read from the live computed style (the dark-theme token
 *    --gt-text-primary), not a hardcoded constant. The mid-shuffle flash colors are the
 *    effect/asset palette in ./effectColors.
 *  - `destroy()` fully restores the original markup + cancels every pending timer, so the
 *    effect is safe to mount/unmount (incl. React StrictMode's double-invoke in dev).
 *
 * REQUIRES a monospace font on the target (every glyph equal width) so swapping characters
 * never reflows the line — the same reason the upstream demo is monospace.
 */
import { EFFECT_COLORS } from "./effectColors";

const NBSP = "\u00A0";

// Letters + symbols the scramble cycles through (upstream `lettersAndSymbols`).
const CHARSET = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q",
  "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "!", "@", "#", "$", "&", "*", "(", ")",
  "-", "_", "+", "=", "/", "[", "]", "{", "}", ";", ":", "<", ">", ",",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

// The first cell of each line shows these for its first few iterations ("looks cooler").
const FIRST_CELL_SYMBOLS = ["*", "-", "\u0027", "\u0022"];

const randomChar = () => CHARSET[Math.floor(Math.random() * CHARSET.length)]!;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

interface CellCache {
  state: string;
  color: string;
}

/** One character cell — wraps a single `<span class="ts-char">`. */
class Cell {
  readonly el: HTMLElement;
  readonly position: number;
  readonly previousCellPosition: number;
  readonly original: string;
  readonly originalColor: string;
  state: string;
  color: string;
  cache: CellCache = { state: "", color: "" };

  constructor(el: HTMLElement, position: number, previousCellPosition: number) {
    this.el = el;
    this.original = el.textContent ?? "";
    this.state = this.original;
    this.originalColor = this.color = getComputedStyle(el).color;
    this.position = position;
    this.previousCellPosition = previousCellPosition;
  }

  set(value: string) {
    this.state = value;
    this.el.textContent = value;
  }
}

interface Line {
  position: number;
  cells: Cell[];
}

/** Wrap every text node's words/chars in spans (`.ts-word` keeps words from breaking). */
function splitChars(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    if (text.trim() === "") continue; // leave whitespace-only formatting nodes alone

    const frag = document.createDocumentFragment();
    for (const token of text.split(/(\s+)/)) {
      if (token === "") continue;
      if (/^\s+$/.test(token)) {
        frag.appendChild(document.createTextNode(token));
        continue;
      }
      const word = document.createElement("span");
      word.className = "ts-word";
      for (const ch of token) {
        const c = document.createElement("span");
        c.className = "ts-char";
        c.textContent = ch;
        word.appendChild(c);
      }
      frag.appendChild(word);
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

/** Group the split chars into visual lines by their rounded top, ordered top→bottom,
 *  and left→right within each line — the Splitting.js `by: 'lines'` result, measured. */
function buildLines(root: HTMLElement): Line[] {
  const chars = [...root.querySelectorAll<HTMLElement>(".ts-char")];
  const groups = new Map<number, HTMLElement[]>();
  for (const el of chars) {
    // Bucket to the nearest 6px so a label (dt) and its value (dd) on the same grid row —
    // whose baselines can differ by a pixel — decode together as one line.
    const top = Math.round(el.getBoundingClientRect().top / 6) * 6;
    (groups.get(top) ?? groups.set(top, []).get(top)!).push(el);
  }
  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((top, lineIndex) => {
      const els = groups
        .get(top)!
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return {
        position: lineIndex,
        cells: els.map((el, i) => new Cell(el, i, i === 0 ? -1 : i - 1)),
      };
    });
}

export class TypeShuffle {
  private readonly root: HTMLElement;
  private readonly originalHTML: string;
  private readonly lines: Line[];
  private readonly totalChars: number;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private animating = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.originalHTML = root.innerHTML;
    splitChars(root);
    this.lines = buildLines(root);
    this.totalChars = this.lines.reduce((n, l) => n + l.cells.length, 0);
  }

  private after(ms: number, fn: () => void) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearCells() {
    for (const line of this.lines) for (const cell of line.cells) cell.set(NBSP);
  }

  /** Effect 5 — clear, then per line cascade the chars in, scrambling with a color slide. */
  private fx5() {
    const MAX_CELL_ITERATIONS = 30;
    let finished = 0;
    this.clearCells();

    const loop = (line: Line, cell: Cell, iteration = 0) => {
      cell.cache = { state: cell.state, color: cell.color };

      if (iteration === MAX_CELL_ITERATIONS - 1) {
        cell.color = cell.originalColor;
        cell.el.style.color = cell.color;
        cell.set(cell.original);
        if (++finished === this.totalChars) this.animating = false;
      } else if (cell.position === 0) {
        cell.color = pick(EFFECT_COLORS);
        cell.el.style.color = cell.color;
        cell.set(iteration < 9 ? pick(FIRST_CELL_SYMBOLS) : randomChar());
      } else {
        const prev = line.cells[cell.previousCellPosition]!;
        cell.set(prev.cache.state);
        cell.color = prev.cache.color;
        cell.el.style.color = cell.color;
      }

      // Empty cells don't count, so the line "fills" from the left before settling.
      if (cell.cache.state !== NBSP) iteration++;
      if (iteration < MAX_CELL_ITERATIONS) this.after(10, () => loop(line, cell, iteration));
    };

    for (const line of this.lines) {
      for (const cell of line.cells) {
        this.after((line.position + 1) * 200, () => loop(line, cell));
      }
    }
  }

  /** Run the decode. No-op if already animating. */
  trigger() {
    if (this.animating) return;
    this.animating = true;
    this.fx5();
  }

  /** Cancel everything and restore the original markup (safe for re-mount). */
  destroy() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.animating = false;
    this.root.innerHTML = this.originalHTML;
  }
}
