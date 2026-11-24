import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { prepareDocument } from './document.mjs';
import { boxOverflow, sourceSections } from '../../scripts/page-checks.mjs';
import { generatePdf, DEFAULT_OPTIMAL_OPTIONS } from '../../packages/playwright/dist/index.js';
import { captureTables, inspectTables } from '../../scripts/check-table-fragments.mjs';
import { writeReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist'), project = join(here, '../..');
const out = join(project, 'output/web-feasibility', process.env.UNSLICED_WEB_CHANNEL === 'chrome' ? 'chrome-auto' : '');
const python = process.env.UNSLICED_PYTHON || 'python3';
const viewport = { width: 1280, height: 1123 };
const names = JSON.parse(await readFile(join(dist, 'samples.json'), 'utf8'));
const optedNames = process.argv.slice(2);
const selected = optedNames.length ? optedNames : names;
for (const name of selected) if (!names.includes(name)) throw new Error(`未知样例：${name}`);
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
const servedFontAssets = [];
const server = createServer(async (request, response) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!path.startsWith(dist + sep) && path !== dist) return response.writeHead(404).end();
    const file = path === dist ? join(dist, 'index.html') : path;
    const body = await readFile(file);
    if (file.startsWith(join(dist, 'fonts') + sep)) servedFontAssets.push({ name: file.split(sep).at(-1), bytes: body.length });
    // Allow reuse between the preview and its measurement iframe, but not across isolated test runs.
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Length': body.length, 'Cache-Control': 'public, max-age=60' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

// Stable first-block identity, not just page lengths. A split table can be
// the first block on several pages, so compare its first row as well.
function starts(plan) {
  return plan.pages.map(page => {
    const item = page.items[0];
    return item ? [item.nodeId, item.selector, item.tagName, item.tableSplit?.startRowIndex ?? null] : null;
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function summary(result) {
  const split = new Set(result.pages.flatMap(p => p.items.filter(i => i.isPartial && !i.tableSplit?.isSplit).map(i => i.nodeId)));
  return {
    starts: starts(result), pageCount: result.pageCount,
    whitespace: result.pages.map(p => +(100 * p.remainingSpace / p.availableHeight).toFixed(1)),
    unwantedSplits: split.size + result.fixes.filter(f => f.type === 'split-oversized-element').length,
    tableCuts: result.pages.flatMap(p => p.items).filter(i => i.tableSplit?.repeatsHeader).length,
    danglingHeadings: result.pages.slice(0, -1).filter(p => /^h[1-6]$/iu.test(p.items.at(-1)?.tagName ?? '')).length,
    issues: result.issues
  };
}

async function reference(browser, name, directory) {
  const source = (await readFile(join(dist, 'samples', name), 'utf8')).trim();
  const html = prepareDocument(name.endsWith('.md') ? { markdown: source } : { html: source });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html);
    const selector = await page.evaluate(() => {
      if (document.querySelectorAll('[data-unsliced-root]').length === 1) return '[data-unsliced-root]';
      const children = Array.from(document.body.children).filter(el => el.tagName !== 'STYLE');
      if (children.length === 1 && ['ARTICLE', 'MAIN', 'DIV', 'SECTION'].includes(children[0].tagName) &&
          !Array.from(document.body.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) {
        if (children[0].id && document.querySelectorAll('#' + CSS.escape(children[0].id)).length === 1) return '#' + CSS.escape(children[0].id);
        return `body > :nth-child(${Array.from(document.body.children).indexOf(children[0]) + 1})`;
      }
      return 'body';
    });
    const sections = await sourceSections(page, selector);
    const tables = await page.locator(selector).evaluate(captureTables);
    const results = {};
    for (const strategy of ['optimal', 'greedy-scored']) {
      const pdf = join(directory, `${strategy}.pdf`);
      const { result } = await generatePdf({ html, selector, playwrightPage: page, page: { format: 'A4' },
        settleTimeoutMs: 0, strategy, config: { optimal: DEFAULT_OPTIMAL_OPTIONS }, output: pdf });
      execFileSync(python, [join(project, 'scripts/render_pdf_pages.py'), pdf, join(directory, strategy), '120']);
      results[strategy] = summary(result);
    }
    return { ...results, sections, tables };
  } finally {
    await context.close();
  }
}

async function snapshot(page) {
  return page.locator('.breakflow-page').evaluateAll(pages => pages.map(page => {
    const origin = page.getBoundingClientRect();
    const relative = b => [b.x - origin.x, b.y - origin.y, b.width, b.height].map(n => +n.toFixed(2));
    const content = page.querySelector('.breakflow-page-content');
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const text = [], anchors = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim() || node.parentElement.closest('style,script,title,desc,defs') ||
          getComputedStyle(node.parentElement).visibility === 'hidden') continue;
      const range = new Range();
      range.selectNodeContents(node);
      if (!range.getClientRects().length) continue;
      text.push(node.data);
      anchors.push(...(node.data.match(/\p{Script=Han}{3,6}|[A-Za-z]{5,12}/gu) ?? []));
    }
    const geometry = [relative(origin), ...Array.from(content.querySelectorAll('*')).map(el =>
      el.getClientRects().length ? relative(el.getBoundingClientRect()) : null)];
    return { text: text.join(''), anchors: [...new Set(anchors)].slice(0, 12), geometry,
      images: content.querySelectorAll('img').length };
  }));
}

async function render(browser, name, mode, directory, ref, measureOnly = false) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const before = servedFontAssets.length;
    await page.goto(base);
    await page.locator('summary').click();
    await page.locator('#samples option').filter({ hasText: name }).waitFor({ state: 'attached' });
    await page.selectOption('#font', mode);
    await page.selectOption('#samples', name);
    await page.click('#sample');
    await page.waitForFunction(() => document.querySelector('#render')?.disabled === false &&
      document.querySelector('#sample')?.disabled === false);
    const plan = await page.evaluate(() => window.webFeasibilityResult);
    if (!plan) throw new Error(await page.locator('#status').innerText());
    const downloads = servedFontAssets.slice(before);
    const font = { readyMs: plan.fontReadyMs, bytes: downloads.filter(d => d.name.endsWith('.woff2')).reduce((sum, d) => sum + d.bytes, 0),
      cssBytes: downloads.filter(d => d.name.endsWith('.css')).reduce((sum, d) => sum + d.bytes, 0),
      files: downloads.filter(d => d.name.endsWith('.woff2')).length, downloads };
    if (measureOnly) return font;
    const screen = await snapshot(page);
    await page.emulateMedia({ media: 'print' });
    const print = await snapshot(page);
    const pdf = join(directory, 'document.pdf');
    const printOptions = { preferCSSPageSize: true, format: 'A4', printBackground: true };
    await page.pdf({ ...printOptions, path: pdf, displayHeaderFooter: false });
    const tables = await page.evaluate(inspectTables, {
      sources: ref.tables, minimum: DEFAULT_OPTIMAL_OPTIONS.minTableRows, issues: plan.issues
    });
    const expected = { sections: ref.sections, headers: tables.headers };
    await writeFile(join(directory, 'text-reference.json'), JSON.stringify(expected));
    await writeFile(join(directory, 'page-reference.json'), JSON.stringify(screen));
    const text = JSON.parse(execFileSync(python, [join(project, 'scripts/verify_pdf_text.py'), pdf],
      { encoding: 'utf8', input: JSON.stringify(expected) }));
    const pdfInfo = JSON.parse(execFileSync(python, [join(here, 'inspect_pdf.py'), pdf, join(directory, 'page')],
      { encoding: 'utf8', input: JSON.stringify(screen) }));
    let headerProbe;
    if (name === 'web-05-bilingual.md' && mode === 'B') {
      const path = join(directory, 'headers-forced.pdf');
      await page.pdf({ ...printOptions, path, displayHeaderFooter: true,
        headerTemplate: '<span>UNSLICED-HEADER-PROBE</span>', footerTemplate: '<span>UNSLICED-FOOTER-PROBE</span>' });
      const probe = JSON.parse(execFileSync(python, [join(project, 'scripts/verify_pdf_text.py'), path],
        { encoding: 'utf8', input: JSON.stringify(expected) }));
      headerProbe = probe.differences.some(line => line.includes('UNSLICED-HEADER-PROBE'));
      execFileSync(python, [join(project, 'scripts/render_pdf_pages.py'), path, join(directory, 'headers-forced'), '120']);
    }
    const layoutWarnings = [...tables.errors, ...await boxOverflow(page)];
    return { font, plan: summary(plan), mcpStartsMatch: same(starts(plan), ref.optimal.starts), pdf: pdfInfo,
      previewMatchesPrint: same(screen, print), pageCountMatch: pdfInfo.pages === plan.pageCount && screen.length === plan.pageCount,
      imageCountsMatch: same(screen.map(page => page.images), pdfInfo.imageCounts),
      textCorrect: !text.differences.length && !pdfInfo.notSearchable.length, text, layoutWarnings, headerProbe };
  } finally {
    await context.close();
  }
}

async function checkControls(browser) {
  const page = await browser.newPage();
  try {
    // Test the handler (not the native dialogue).
    await page.addInitScript(() => { window.print = () => { window.printInvocations = (window.printInvocations ?? 0) + 1; }; });
    await page.goto(base);
    const renderText = async text => {
      await page.locator('#markdown').fill(text);
      if (await page.locator('#print').isEnabled()) throw new Error('改动后仍可打印旧预览');
      await page.click('#render');
      await page.waitForFunction(() => document.querySelector('#render')?.disabled === false);
    };
    await renderText('# 初次预览\n\n打印按钮测试。');
    await page.click('#print');
    if (await page.evaluate(() => window.printInvocations) !== 1) throw new Error('按钮没有请求浏览器打印');
    await page.selectOption('#font', 'B');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('字体 B'));
    await renderText('![外链](https://example.invalid/track.png)');
    if (!(await page.locator('#status').innerText()).includes('不读取外部网址')) throw new Error('没有拒绝外链图片');
    await renderText('<style>body { display: none }</style>');
    if (!(await page.locator('#status').innerText()).includes('不接受直接写入的 HTML')) throw new Error('没有拒绝原样插入 HTML');
  } finally {
    await page.close();
  }
}

async function clearImages(directory) {
  await mkdir(directory, { recursive: true });
  for (const file of await readdir(directory)) {
    if (/^(page|optimal|greedy-scored|headers-forced)-\d+\.png$/u.test(file)) await unlink(join(directory, file));
  }
}

let browser;
try {
  browser = await chromium.launch({ channel: process.env.UNSLICED_WEB_CHANNEL || undefined });
  await checkControls(browser);
  const rows = [], errorRows = [];
  for (const name of selected) {
    const slug = name.replace(/\.(md|html)$/u, '-$1');
    const directory = join(out, slug);
    await clearImages(join(directory, 'mcp'));
    let ref;
    try { ref = await reference(browser, name, join(directory, 'mcp')); }
    catch (error) { errorRows.push({ name, error: 'MCP: ' + error.message }); continue; }
    const row = { name, slug, optimal: ref.optimal, greedy: ref['greedy-scored'] };
    rows.push(row);
    for (const mode of ['A', 'B']) {
      const target = join(directory, mode);
      await clearImages(target);
      try { row[mode] = await render(browser, name, mode, target, ref); }
      catch (error) { errorRows.push({ name, mode, error: error.message }); }
    }
    console.log(name, ...['A', 'B'].map(mode => row[mode]
      ? `${mode}: ${row[mode].mcpStartsMatch ? '同断点' : '不同断点'} / ${row[mode].pdf.pages} 页 / ${row[mode].textCorrect ? '文字正确' : '文字有差异'}`
      : `${mode}: 出错`));
  }
  const measurements = {};
  for (const name of ['web-01-report.md', 'web-02-table.md', 'web-05-bilingual.md'].filter(n => selected.includes(n))) {
    measurements[name] = {};
    for (const mode of ['A', 'B']) {
      if (!rows.find(row => row.name === name)?.[mode]) continue;
      measurements[name][mode] = [];
      for (let run = 0; run < 3; run++) measurements[name][mode].push(await render(browser, name, mode, out, null, true));
    }
  }
  const report = { browser: browser.version(), viewport, controlsPassed: true, rows, errorRows, measurements };
  await writeFile(join(out, optedNames.length ? 'metrics-partial.json' : 'metrics.json'), JSON.stringify(report, null, 2));
  await writeReport(out, report, Boolean(optedNames.length));
  for (const row of errorRows) console.error(row);
  // Differences are findings, not skipped checks. Exit nonzero on unmet checks.
  if (errorRows.length || rows.some(row => ['A','B'].some(mode => {
    const r = row[mode];
    return !r?.mcpStartsMatch || !r.pageCountMatch || !r.previewMatchesPrint || !r.textCorrect || !r.imageCountsMatch ||
      r.pdf.blank.length || r.pdf.nonA4.length || r.pdf.pageTextMismatch.length || r.layoutWarnings.length;
  }))) process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
