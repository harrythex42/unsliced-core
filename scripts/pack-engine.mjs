import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output', 'engine-release');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('Pack the engine from a clean checkout.');
const commit = git('rev-parse', 'HEAD');
const upstream = 'https://github.com/harrythex42/unsliced-core';
const require = createRequire(new URL('../packages/playwright/package.json', import.meta.url));
const playwright = require('playwright/package.json').version;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fonts = 'assets/fonts';
const files = ['runtime/index.mjs', 'runtime/index.global.js',
  `${fonts}/UnslicedSansSC.ttf`, `${fonts}/OFL.txt`, `${fonts}/README.md`, 'LICENSE'];
const notice = '/*! Generated from Unsliced Core; BreakFlow and Unsliced contributors — MIT. See ../LICENSE. */';
const archive = 'unsliced-engine.tar.gz';

await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, 'stage-'));
try {
  const engine = join(staging, 'engine');
  for (const file of files) await mkdir(dirname(join(engine, file)), { recursive: true });
  await build({
    stdin: {
      contents: "export { DEFAULT_OPTIMAL_OPTIONS, generatePdf } from './packages/playwright/dist/index.js';",
      resolveDir: root,
      sourcefile: 'unsliced-engine-entry.mjs'
    },
    bundle: true, format: 'esm', platform: 'node', target: 'node22',
    external: ['playwright'], minify: true, outfile: join(engine, files[0]), banner: { js: notice }
  });
  const browser = await readFile(join(root, 'packages/browser/dist/index.global.js'), 'utf8');
  await writeFile(join(engine, files[1]), notice + '\n' +
    browser.replace(/\r?\n\/\/# sourceMappingURL=[^\r\n]+/u, ''));
  for (const file of files.slice(2)) {
    await copyFile(join(root, file === 'LICENSE' ? file : join('packages/playwright', file)), join(engine, file));
  }
  const sha256 = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, hash(await readFile(join(engine, file)))])));
  await writeFile(join(engine, 'manifest.json'), JSON.stringify({ upstream, commit, playwright, sha256 }, null, 2) + '\n');
  const path = join(output, archive);
  execFileSync('tar', ['-czf', path, '-C', staging, 'engine'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await writeFile(path + '.sha256', `${hash(await readFile(path))}  ${archive}\n`);
  console.log(`${commit}: ${path}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
