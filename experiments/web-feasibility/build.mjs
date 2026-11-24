import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const dist = join(here, 'dist');
const python = process.env.UNSLICED_PYTHON || 'python3';
await mkdir(dist, { recursive: true });
if (!process.argv.includes('--reuse-fonts')) {
  execFileSync(python, [join(here, 'subset_font.py'), join(dist, 'fonts')], { stdio: 'inherit' });
}
const { mcp, parts } = JSON.parse(await readFile(join(dist, 'fonts/ranges.json'), 'utf8'));
const face = (src, ranges) => `@font-face{font-family:"Unsliced Sans SC";src:${src};font-weight:400;unicode-range:${ranges}}`;
await writeFile(join(dist, 'fonts/a.css'), face(
  ['PingFangSC-Regular', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'WenQuanYi Micro Hei'].map(name => `local("${name}")`).join(','), mcp));
await writeFile(join(dist, 'fonts/b.css'), parts.map((ranges, i) =>
  face(`url("sc-${String(i).padStart(2, '0')}.woff2") format("woff2")`, ranges)).join('\n'));
const sampleDir = join(root, 'samples');
const names = (await readdir(sampleDir, { recursive: true })).filter(n => /\.(html|md)$/u.test(n)).sort();
await mkdir(join(dist, 'samples'), { recursive: true });
execFileSync(python, [join(here, 'fixtures.py'), sampleDir, join(dist, 'samples')], { stdio: 'inherit' });
for (const name of names.filter(name => extname(name) === '.md')) {
  const dest = join(dist, 'samples', name);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(sampleDir, name), dest);
}
await writeFile(join(dist, 'samples.json'), JSON.stringify(names));
await build({
  entryPoints: [join(here, 'app.mjs')],
  outfile: join(dist, 'app.js'), bundle: true, platform: 'browser', format: 'esm',
  banner: { js: '/*! BreakFlow and Unsliced contributors — MIT; see LICENSE. */' }
});
for (const [source, target] of [
  [join(here, 'index.html'), 'index.html'],
  [join(here, 'ui.css'), 'ui.css'],
  [join(root, 'packages/browser/dist/index.global.js'), 'breakflow.js'],
  [join(root, 'LICENSE'), 'LICENSE']
]) await copyFile(source, join(dist, target));
console.log(`实验网页：${dist}`);
