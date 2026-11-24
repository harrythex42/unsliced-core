import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { pageCostModel } from '../../packages/core/dist/index.js';
import { analyzePdf, generatePdf } from '../../packages/playwright/dist/index.js';
import { boxOverflow, sourceSections } from '../page-checks.mjs';
import { captureTables, inspectTables } from '../check-table-fragments.mjs';
import { digest, prepareDocuments } from './documents.mjs';
import { planPilotV2, seedV2 } from './pilot-v2.mjs';
import { baseline, nearbyProfiles } from './profiles.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const root = join(project, 'output', 'review');
const datasetId = randomUUID();
const directory = join(root, 'datasets', datasetId);
const archive = join(directory, 'sources');
const python = process.env.UNSLICED_PYTHON || 'python3';
const nearby = process.argv.includes('--near-default');
process.env.PYTHONUTF8 = '1';
execFileSync(python, ['-c', 'import pymupdf, pypdf']);

const profiles = nearby ? nearbyProfiles : [baseline];
if (!nearby) {
  for (const tableSplitLines of [28, 0, 42, 8, 20]) {
    for (const [freeLines, growth, fixedLines] of [
      [2, 1.18, 15], [0, 1.08, 0], [6, 1.12, 13], [14, 1.06, 21],
      [1, 1.25, 29], [2, 1.18, 40], [0, 1.2, 4], [28, 1.1, 38],
      [44, 1.08, 0], [0, 1.045, 80], [0, 1.28, 0], [9, 1.15, 6]
    ]) profiles.push({ ...baseline, tableSplitLines, freeLines, growth, fixedLines });
  }
}

const probe = {
  globalName: 'reviewProbe',
  script: `window.reviewProbe = { name: 'review-probe', paginate(input) {
    const results = [], seen = new Map();
    let representative;
    for (const options of ${JSON.stringify(profiles)}) {
      try {
        const plan = new BreakFlow.OptimalStrategy(options).paginate(input);
        if (!plan.pages.length || plan.issues.some(issue => issue.severity === 'error')) continue;
        const signature = JSON.stringify(plan.pages.map(page => page.items.map(item => [item.nodeId, item.tableSplit])));
        const existing = seen.get(signature);
        if (existing) {
          if (${nearby}) existing.equivalentOptions.push(options);
          continue;
        }
        representative ??= plan;
        const candidate = { options, signature, equivalentOptions: [options] };
        seen.set(signature, candidate);
        results.push(candidate);
      } catch { /* This profile has no feasible plan for this source. */ }
    }
    return { ...(representative ?? {pages: [], fixes: []}), issues: [{ details: { results } }] };
  } };`
};

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg' };
const sourceServer = createServer(async (req, res) => {
  try {
    const path = resolve(archive, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(archive + sep)) return res.writeHead(404).end();
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }).end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});

function details(result, params) {
  const lineHeightPx = result.metrics.lineHeightPx;
  const model = pageCostModel(params);
  const fixedPageCost = model.cost(0, lineHeightPx, true);
  const pages = result.pages.map((page, i) => {
    const slices = page.items.filter(item => item.tableSplit?.isSplit).map(item => ({
      id: item.nodeId, selector: item.selector, ...item.tableSplit
    }));
    const tableBreaks = slices.filter(slice => slice.startRowIndex > 0).length;
    const whitespaceCost = model.cost(page.remainingSpace, lineHeightPx, i === result.pages.length - 1) - fixedPageCost;
    return {
      page: page.pageNumber, remainingPx: page.remainingSpace, availablePx: page.availableHeight,
      whitespacePercent: 100 * Math.max(0, page.remainingSpace) / page.availableHeight,
      fixedPageCost, whitespaceCost, tableBreaks, tableSplitCost: tableBreaks * model.splitCost,
      boundaryPenalty: 0, tableSlices: slices
    };
  });
  const sum = field => pages.reduce((total, page) => total + page[field], 0);
  return { lineHeightPx, pages, issues: result.issues,
    protectedBoundaryRelaxations: result.issues.filter(issue => issue.type === 'orphan-heading').length,
    shortTableFragments: result.issues.filter(issue => issue.type === 'short-table-fragment').length,
    fixedPageCost: sum('fixedPageCost'), whitespaceCost: sum('whitespaceCost'),
    tableSplitCost: sum('tableSplitCost'), boundaryPenalty: sum('boundaryPenalty'),
    total: sum('fixedPageCost') + sum('whitespaceCost') + sum('tableSplitCost') + sum('boundaryPenalty') };
}

async function processDocument(browser, url, document) {
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  try {
    await page.emulateMedia({ media: 'print' });
    await page.goto(url, { waitUntil: 'networkidle' });
    const selector = document.selector ?? await page.evaluate(() => {
      if (document.querySelectorAll('[data-unsliced-root]').length === 1) return '[data-unsliced-root]';
      return document.body.children.length === 1 && document.body.firstElementChild.matches('main, article')
        ? 'body > :first-child' : 'body';
    });
    const source = await page.locator(selector).evaluate(captureTables);
    const sections = await sourceSections(page, selector);
    const options = { url, selector, playwrightPage: page, settleTimeoutMs: 0 };
    const analysis = await analyzePdf({ ...options, strategy: probe });
    const candidates = analysis.issues[0]?.details?.results || [];
    const variants = [];
    const visual = new Map();
    const rejected = [];
    if (!nearby && candidates.length <= 1) return { ...document, variants, rejected };
    for (const { options: params, signature, equivalentOptions } of candidates) {
      if (!nearby && variants.length >= 8) break;
      const id = digest(document.id + '\0' + signature).slice(0, 20);
      const folder = join(directory, 'renders', id);
      await mkdir(folder, { recursive: true });
      const pdf = join(folder, 'document.pdf');
      try {
        const { result } = await generatePdf({
          ...options, strategy: 'optimal', config: { optimal: params }, output: pdf
        });
        const tables = await page.evaluate(inspectTables, { sources: source, minimum: params.minTableRows, issues: result.issues });
        const errors = [...await boxOverflow(page), ...tables.errors,
          ...result.issues.filter(issue => issue.severity === 'error').map(issue => issue.message)];
        const printed = JSON.parse(execFileSync(python, [join(project, 'scripts/verify_pdf_text.py'), pdf], {
          encoding: 'utf8', input: JSON.stringify({ sections, headers: tables.headers })
        }));
        errors.push(...printed.differences);
        if (printed.pages !== result.pages.length) errors.push('页数不一致');
        if (errors.length) { rejected.push({ id, reason: errors[0] }); continue; }
        execFileSync(python, [join(project, 'scripts/render_pdf_pages.py'), pdf, join(folder, 'page'), '84']);
        const images = (await readdir(folder)).filter(name => /^page-\d+\.png$/u.test(name)).sort();
        if (images.length !== printed.pages) throw new Error('图像页数不一致');
        const imageHashes = await Promise.all(images.map(async image => digest(await readFile(join(folder, image)))));
        const visualId = digest(imageHashes.join('\n'));
        const existing = visual.get(visualId);
        if (existing) {
          if (nearby) existing.equivalentOptions.push(...equivalentOptions);
          continue;
        }
        const variant = { id, options: params, visualId, signature, images, costs: details(result, params),
          ...(nearby && { equivalentOptions }) };
        visual.set(visualId, variant);
        variants.push(variant);
      } catch (error) {
        rejected.push({ id, reason: error.message.split('\n')[0] });
      }
    }
    return { ...document, selector, variants, rejected };
  } finally {
    await page.close();
  }
}

const docs = await prepareDocuments(project, archive);
sourceServer.listen(0, '127.0.0.1');
await once(sourceServer, 'listening');
let browser;
try {
  browser = await chromium.launch(process.env.UNSLICED_CHROMIUM ? { executablePath: process.env.UNSLICED_CHROMIUM } : {});
  const base = 'http://127.0.0.1:' + sourceServer.address().port + '/';
  const results = [];
  for (const [index, document] of docs.entries()) {
    const url = base + document.path.split('/').map(encodeURIComponent).join('/');
    try {
      results.push(await processDocument(browser, url, document));
    } catch (error) {
      results.push({ ...document, variants: [], rejected: [{ reason: error.message.split('\n')[0] }] });
    }
    const result = results.at(-1);
    console.log(`[${index + 1}/${docs.length}] ${document.path} · ${result.variants.length} 种版式`);
  }
  const pairCount = results.reduce((sum, doc) => sum + doc.variants.length * (doc.variants.length - 1) / 2, 0);
  const activeDocuments = results.filter(doc => doc.variants.length > 1).length;
  const manifest = { version: 1, datasetId, createdAt: new Date().toISOString(), browser: browser.version(),
    profiles, activeDocuments, pairCount, documents: results, ...(nearby && { profileSet: 'near-default' }) };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (nearby) {
    const { stats, ready } = planPilotV2(manifest);
    const summary = { seed: seedV2, ready, profiles: profiles.length, documents: results.length,
      validatedLayouts: results.reduce((n, doc) => n + doc.variants.length, 0),
      rejectedLayouts: results.reduce((n, doc) => n + doc.rejected.length, 0), ...stats };
    await writeFile(join(directory, 'pilot-v2-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log('近默认值材料已单独归档，未替换现有题库：' + directory);
    console.log(`试评：${stats.originals} 道原题，${stats.repeats} 道重复题${ready ? '。' : '，不足 40 道，未启用。'}`);
  } else {
    if (pairCount < 100) throw new Error('生成了 ' + pairCount + ' 组非重复比较，少于 100。详见 ' + directory);
    const staging = join(root, 'current-' + datasetId + '.json');
    await writeFile(staging, JSON.stringify({ datasetId }));
    await rename(staging, join(root, 'current.json'));
  }
  console.log(`${results.length} 份文档，${activeDocuments} 份产生差异，${pairCount} 组可评。`);
} finally {
  await browser?.close();
  sourceServer.close();
}
