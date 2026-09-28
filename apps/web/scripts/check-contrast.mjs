// WCAG 2.x contrast check for the light and dark color tokens in src/index.css.
// Usage: pnpm --filter ./apps/web check:contrast [path/to/index.css]
// Exits 1 when a token a pair needs is missing, the dark set is missing, or a pair is below its minimum.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] ?? fileURLToPath(new URL('../src/index.css', import.meta.url));
const css = readFileSync(file, 'utf8');

/**
 * Token blocks: `:root` is the light set and `.dark` the dark set. A plain `@theme` block (Tailwind
 * names, `--color-x`) is read as the light set too, so the check also runs on a stylesheet that
 * defines its colors only there.
 */
const variants = {};
for (const m of css.matchAll(/(^|\n)\s*(:root|\.dark|@theme)\s*\{([^}]*)\}/g)) {
  const name = m[2] === '.dark' ? 'dark' : 'light';
  variants[name] ??= {};
  const vars = variants[name];
  for (const d of m[3].matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const key = m[2] === '@theme' ? d[1].replace(/^color-/, '') : d[1];
    vars[key] = d[2].trim();
  }
}

/** Parses `oklch(L C H)` / `oklch(L C H / A)` (L and A as a number or a percentage) to linear sRGB. */
function parse(value) {
  const m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(value ?? '');
  if (!m) return null;
  const pct = (s) => (s.endsWith('%') ? Number.parseFloat(s) / 100 : Number.parseFloat(s));
  const L = pct(m[1]);
  const C = Number.parseFloat(m[2]);
  const h = (Number.parseFloat(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    alpha: m[4] === undefined ? 1 : pct(m[4]),
  };
}

// Mixes in gamma-encoded sRGB, as the browser composites a translucent color. Tailwind's `bg-x/15`
// mixes in oklab instead; for these tokens the two land within 0.2 of each other (checked against
// culori's oklab interpolation).
const toGamma = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const toLinear = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
function mix(top, bottom, t) {
  const ch = (k) => toLinear(toGamma(top[k]) * t + toGamma(bottom[k]) * (1 - t));
  return { r: ch('r'), g: ch('g'), b: ch('b'), alpha: 1 };
}
const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const ratio = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Resolves a surface spec to an opaque color: `card`, or `success/15@card` for a `bg-success/15`
 * tint drawn over `card`. Translucent tokens are composited over `over` (default `background`).
 */
function resolve(spec, vars, missing, over) {
  const m = /^([\w-]+)(?:\/(\d+)@([\w-]+))?$/.exec(spec);
  const token = (name) => {
    const c = parse(vars[name]);
    if (!c) missing.add(name);
    return c;
  };
  const base = over ?? token('background');
  const opaque = (c) => (c && base && c.alpha < 1 ? mix(c, base, c.alpha) : c);
  const color = opaque(token(m[1]));
  if (!m[2]) return color;
  const under = opaque(token(m[3]));
  return color && under ? mix(color, under, Number(m[2]) / 100) : null;
}

// [foreground, surface, minimum, note]
const TEXT = 4.5;
const UI = 3;
const PAIRS = [
  ['foreground', 'background', TEXT],
  ['foreground', 'muted', TEXT],
  ['card-foreground', 'card', TEXT],
  ['popover-foreground', 'popover', TEXT],
  ['primary-foreground', 'primary', TEXT],
  ['secondary-foreground', 'secondary', TEXT],
  ['muted-foreground', 'background', TEXT],
  ['muted-foreground', 'muted', TEXT],
  ['muted-foreground', 'card', TEXT],
  ['accent-foreground', 'accent', TEXT],
  ['primary', 'background', TEXT, 'text-primary links'],
  ['destructive', 'background', TEXT, 'text-destructive'],
  ['destructive', 'card', TEXT, 'text-destructive'],
  ['destructive-foreground', 'destructive', TEXT],
  ['success', 'background', TEXT, 'text-success'],
  ['success', 'card', TEXT, 'text-success'],
  ['success-foreground', 'success', TEXT],
  ['warning', 'background', TEXT, 'text-warning'],
  ['warning', 'card', TEXT, 'text-warning'],
  ['warning-foreground', 'warning', TEXT],
  ['info', 'background', TEXT, 'text-info'],
  ['info', 'card', TEXT, 'text-info'],
  ['info-foreground', 'info', TEXT],
  ['sidebar-foreground', 'sidebar', TEXT],
  ['sidebar-primary-foreground', 'sidebar-primary', TEXT],
  ['sidebar-accent-foreground', 'sidebar-accent', TEXT],
  ['success', 'success/15@card', TEXT, 'soft badge'],
  ['warning', 'warning/15@card', TEXT, 'soft badge'],
  ['info', 'info/15@card', TEXT, 'soft badge'],
  ['destructive', 'destructive/15@card', TEXT, 'soft badge'],
  ['primary', 'primary/15@card', TEXT, 'soft badge'],
  ['foreground', 'highlight', TEXT, 'search match <mark>'],
  ['terminal-foreground', 'terminal', TEXT, 'terminal dock'],
  ['foreground', 'warning/10@background', TEXT, 'notice panel'],
  ['foreground', 'success/20@background', TEXT, 'passing test chip'],
  ['input', 'background', UI, 'form control border'],
  ['input', 'card', UI, 'form control border'],
  ['ring', 'background', UI, 'focus ring'],
  ['ring', 'card', UI, 'focus ring'],
];

let failed = 0;
for (const name of ['light', 'dark']) {
  const vars = variants[name];
  console.log(`\n${name}`);
  if (!vars) {
    failed++;
    console.log(`  FAIL  no ${name} token set in ${file}`);
    continue;
  }
  for (const [fg, bg, min, note] of PAIRS) {
    const missing = new Set();
    const surface = resolve(bg, vars, missing);
    const text = surface && resolve(fg, vars, missing, surface);
    const label = `${fg} on ${bg}${note ? `  (${note})` : ''}`;
    if (!text) {
      failed++;
      console.log(`  FAIL    n/a  (>= ${min})  ${label}  missing: ${[...missing].join(', ')}`);
      continue;
    }
    const r = ratio(text, surface);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${r.toFixed(2).padStart(5)}  (>= ${min})  ${label}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll pairs meet WCAG AA');
process.exit(failed ? 1 : 0);
