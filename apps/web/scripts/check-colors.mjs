// Fails on raw Tailwind palette classes and arbitrary hex colors in app code, so screens use the
// Calm theme tokens (bg-background, text-muted-foreground, border-input, ...) instead.
// Usage: pnpm --filter ./apps/web check:colors [dir]
// Scans every .tsx file under dir (default src/) except src/components/ui, the shadcn primitives.
// Prints file:line for each hit and exits 1 when there is any. `bg-black/NN` overlays are allowed:
// black and white are not in the palette list below.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../src', import.meta.url));
const skip = join('components', 'ui');

const palette =
  /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|placeholder|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const hex = /\[#[0-9a-fA-F]{3,8}\]/g;

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(root, path) === skip || relative(root, path).startsWith(skip + sep)) continue;
      yield* tsxFiles(path);
    } else if (entry.name.endsWith('.tsx')) {
      yield path;
    }
  }
}

const hits = [];
for (const file of tsxFiles(root)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of [...line.matchAll(palette), ...line.matchAll(hex)]) {
      hits.push(`${relative(process.cwd(), file)}:${i + 1}: ${m[0]}`);
    }
  });
}

if (hits.length > 0) {
  console.error(hits.join('\n'));
  console.error(`\n${hits.length} raw color class(es); use a theme token instead.`);
  process.exit(1);
}
console.log('check:colors: no raw palette or hex color classes.');
