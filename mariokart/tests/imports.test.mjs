// Every import in the app (static and dynamic) must point at a file that
// exists. Catches broken relative paths after moving files around, which the
// UI smoke test can miss when the code path (e.g. photo reading) isn't run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

test('every relative import in js/ resolves to a real file', () => {
  const files = walk(join(root, 'js')).filter((f) => f.endsWith('.js'));
  const broken = [];
  let count = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]).filter((s) => s.startsWith('.'));
    for (const s of specs) {
      count++;
      if (!existsSync(resolve(dirname(file), s))) broken.push(`${file.slice(root.length + 1)} → ${s}`);
    }
  }
  assert.ok(count > 20, `found only ${count} imports; the scan is broken`);
  assert.deepEqual(broken, []);
});

test('every file index.html preloads or loads exists', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const local = [...html.matchAll(/(?:href|src)="((?:js|css)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(local.length > 5);
  assert.deepEqual(local.filter((p) => !existsSync(join(root, p))), []);
});
