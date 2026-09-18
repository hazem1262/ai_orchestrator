import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = ['PGPASSWORD=hunter2'];
const BAD = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_/,
  /sk-ant-/,
  /xox[abposr]-/,
  /AKIA[0-9A-Z]{16}/,
  /\/Users\/hazem/,
  /wakecap\.com/i,
  /amazonaws\.com/,
];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems = [];
for (const file of walk('fixtures')) {
  let text = readFileSync(file, 'utf8');
  for (const a of ALLOW) text = text.replaceAll(a, '');
  for (const re of BAD) if (re.test(text)) problems.push(`${file}: matches ${re}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('fixtures clean');
