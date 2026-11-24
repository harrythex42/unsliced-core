import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { boxOverflow, sourceSections } from './page-checks.mjs';
import { captureTables, inspectTables } from './check-table-fragments.mjs';
import { pageCostModel } from '../packages/core/dist/index.js';
import { generatePdf } from '../packages/playwright/dist/index.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const samples = join(project, 'samples');
const letterDemo = process.argv.includes('--letter-demo');
const paper = letterDemo ? 'Letter' : 'A4';
const output = join(project, 'output', letterDemo ? 'acceptance-letter-demo' : 'acceptance');
const textVerifier = join(project, 'scripts', 'verify_pdf_text.py');
const python = process.env.UNSLICED_PYTHON || 'python3';
process.env.PYTHONUTF8 = '1';
const cases = {
  'breakflow-report-zh.html': { selector: '#community-report', expectBundledFont: true },
  'invoice.html': { selector: '#invoice-container' },
  'root-text.html': { selector: '#report' },
  'root-font-size.html': {
    selector: '#report',
    styles: [
      { selector: '#styled-heading', property: 'font-size', value: '42px' },
      { selector: '#styled-paragraph', property: 'font-size', value: '19px' }
    ]
  },
  'block-limit.html': { selector: '#report' },
  'table-long.html': { mustSplit: true },
  'table-small.html': { mustStayWhole: true },
  'table-heading.html': { mustKeepTableIntro: true },
  'northline-quarterly.html': { mustSplit: true },
  'alder-launch-retrospective.html': { mustSplit: true },
  'bracken-device-guide.html': { mustSplit: true },
  'harborlight-service-review.html': { mustSplit: true },
  'cedarway-readiness-report.html': { mustSplit: true }
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

async function startSampleServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = resolve(samples, '.' + pathname);
      if (!file.startsWith(samples + sep)) {
        response.writeHead(404).end();
        return;
      }
      const contents = await readFile(file);
      response.setHeader('Content-Type', contentTypes[extname(file)] ?? 'application/octet-stream');
      response.end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  return server;
}

async function prepareOutput(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) {
    if (name === 'document.pdf' || /^page-\d+\.png$/u.test(name)) {
      await unlink(join(directory, name));
    }
  }
}

async function checkSample(browser, url, filename, strategy, splitLines, faults = false) {
  const spec = cases[filename] ?? {};
  const directory = join(output, splitLines === undefined ? strategy : 'penalty-' + splitLines, filename.slice(0, -'.html'.length));
  const pdf = join(directory, 'document.pdf');
  const row = { filename, strategy, directory, details: [] };
  await prepareOutput(directory);
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  try {
    await page.emulateMedia({ media: 'print' });
    await page.goto(url, { waitUntil: 'networkidle' });
    const selector = spec.selector ?? await page.evaluate(() => {
      if (document.querySelectorAll('[data-unsliced-root]').length === 1) return '[data-unsliced-root]';
      const body = document.body;
      const visibleChildren = Array.from(body.children).filter(element =>
        !element.matches('script, style, template, noscript') &&
        getComputedStyle(element).display !== 'none' &&
        getComputedStyle(element).visibility !== 'hidden'
      );
      const hasBareText = Array.from(body.childNodes).some(node =>
        node.nodeType === Node.TEXT_NODE && node.textContent.trim()
      );
      if (!hasBareText && visibleChildren.length === 1 && visibleChildren[0].matches('main, article')) {
        const index = Array.from(body.children).indexOf(visibleChildren[0]) + 1;
        return `body > :nth-child(${index})`;
      }
      return 'body';
    });
    const sections = await sourceSections(page, selector);
    const sources = await page.locator(selector).evaluate(captureTables);
    const optimal = { tableSplitLines: splitLines };
    const model = pageCostModel(optimal);
    const { result } = await generatePdf({ url, selector, strategy, config: { optimal }, page: { format: paper },
      output: pdf, playwrightPage: page, settleTimeoutMs: 0 });

    const checkTables = () => page.evaluate(inspectTables, { sources, minimum: 2, issues: result.issues });
    const tables = await checkTables();
    row.details.push(...tables.errors);
    if (spec.mustSplit && !tables.parts.length) row.details.push('超页长表没有分段。');
    if (spec.mustStayWhole && tables.parts.length) row.details.push('3 行小表必须整表移动。');
    if (spec.mustKeepTableIntro) {
      const together = await page.locator('.breakflow-page').evaluateAll(pages =>
        pages.some(page => page.querySelector('h2') && page.querySelector('p.intro') && page.querySelector('tbody tr')));
      if (!together) row.details.push('表前标题、说明和首行未在同一页。');
    }
    row.parts = tables.parts;
    row.cuts = tables.parts.reduce((sum, parts) => sum + parts.length - 1, 0);
    if (faults) await testTableFaults(page, directory, sections, checkTables);

    execFileSync(python, [join(project, 'scripts/render_pdf_pages.py'), pdf, join(directory, 'page'), '120']);
    const text = JSON.parse(execFileSync(python, [textVerifier, pdf], {
      encoding: 'utf8', input: JSON.stringify({ sections, headers: tables.headers })
    }));
    row.pages = text.pages;
    row.cost = result.pages.reduce((cost, page, i) => cost + model.cost(
      page.remainingSpace, result.metrics.lineHeightPx, i === result.pages.length - 1), row.cuts * model.splitCost);
    row.notes = result.issues.map(issue => issue.message);
    row.images = (await readdir(directory)).filter(name => /^page-\d+\.png$/u.test(name)).sort((a,b) => a.localeCompare(b, 'en', {numeric:true}));
    row.textMatches = text.differences.length === 0;
    row.whitespace = result.pages.map(entry => (100 * entry.remainingSpace / entry.availableHeight).toFixed(1) + '%');
    row.splits = new Set(result.pages.flatMap(entry => entry.items
      .filter(item => item.isPartial && !item.tableSplit?.isSplit).map(item => item.nodeId))).size;
    row.splits += result.fixes.filter(fix => fix.type === 'split-oversized-element').length;
    row.orphans = result.pages.slice(0, -1).filter(entry => /^h[1-6]$/iu.test(entry.items.at(-1)?.tagName ?? '')).length;
    row.details.push(...text.differences);
    if (spec.expectBundledFont && !text.embeddedFonts.some(name => /UnslicedSansSC/u.test(name))) {
      row.details.push('未在 PDF 中发现嵌入的 Unsliced Sans SC 字体。');
    } else if (spec.expectBundledFont) {
      row.notes.push('PDF 已嵌入随项目分发的 Unsliced Sans SC。');
    }
    row.details.push(...await boxOverflow(page));
    row.details.push(...result.issues.filter(issue => issue.severity === 'error').map(issue => issue.message));
    if (text.pages !== result.pageCount) row.details.push(`分页计划为 ${result.pageCount} 页，实际 PDF 为 ${text.pages} 页。`);
    const imageCount = (await readdir(directory)).filter(name => /^page-\d+\.png$/u.test(name)).length;
    if (imageCount !== text.pages) row.details.push(`生成了 ${imageCount} 张页面图片，应有 ${text.pages} 张。`);
    if (row.splits) row.details.push(`有 ${row.splits} 个内容块被拆开。`);
    if (row.orphans) row.details.push(`有 ${row.orphans} 个标题落在页底，与后续内容分开。`);
    for (const style of spec.styles ?? []) {
      const values = await page.locator('.breakflow-page ' + style.selector).evaluateAll(
        (nodes, property) => nodes.map(node => getComputedStyle(node).getPropertyValue(property)), style.property
      );
      if (values.length === 0 || values.some(value => value !== style.value)) {
        row.details.push(`${style.selector} 的 ${style.property} 实际为 ${values.join('、') || '缺失'}，应为 ${style.value}。`);
      } else {
        (row.notes ??= []).push(`${style.selector} 的字号经浏览器确认是 ${style.value}。`);
      }
    }
  } catch (error) {
    row.details.push(error.message.split('\n')[0]);
  } finally {
    await page.close();
  }
  return row;
}

async function testTableFaults(page, directory, sections, inspect) {
  const faultPdf = join(directory, 'fault.pdf');
  const evidence = [];
  for (const fault of ['missing-header', 'half-row']) {
    // Mutate only detached-page output in this browser tab. Restore the exact
    // nodes between trials. The PDF text and DOM checks run on the same fault.
    await page.evaluate(fault => {
      const [first, second] = document.querySelectorAll('table.breakflow-table-slice');
      if (!second) throw new Error('故障检验需要至少两段表格');
      if (fault === 'missing-header') {
        const head = second.tHead;
        const next = head.nextSibling;
        head.remove();
        window.restoreProbe = () => second.insertBefore(head, next);
      } else {
        const row = first.tBodies[0].lastElementChild;
        const half = row.cloneNode(true);
        const cell = row.cells[row.cells.length - 1];
        const original = cell.textContent;
        const mid = Math.floor(original.length / 2);
        cell.textContent = original.slice(0, mid);
        for (const cell of half.cells) cell.textContent = '';
        half.cells[half.cells.length - 1].textContent = original.slice(mid);
        second.tBodies[0].prepend(half);
        window.restoreProbe = () => { cell.textContent = original; half.remove(); };
      }
    }, fault);
    try {
      const result = await inspect();
      await page.pdf({ path: faultPdf, format: 'A4', printBackground: true });
      const text = JSON.parse(execFileSync(python, [textVerifier, faultPdf], {
        encoding: 'utf8', input: JSON.stringify({ sections, headers: result.headers })
      }));
      const expected = fault === 'missing-header' ? '表头缺失' : '数据行被切开';
      const message = result.errors.find(error => error.includes(expected));
      if (!message || (fault === 'missing-header' && !text.differences.length)) throw new Error('漏报故障 ' + fault);
      evidence.push(fault + ' — ' + message);
    } finally {
      await page.evaluate(() => { window.restoreProbe(); delete window.restoreProbe; });
      await unlink(faultPdf).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  await writeFile(join(output, 'table-faults.txt'), evidence.join('\n') + '\n');
}

function renderReport(rows, browser) {
  const launch = browser.launchMode === 'custom-executable'
    ? '通过 `UNSLICED_CHROMIUM` 指定浏览器'
    : '由 Playwright 启动默认 Chromium';
  const lines = [
    '# Unsliced 排版验收', '', '[打开逐页并排图片](comparison.html)', '',
    `纸张：${paper === 'Letter' ? 'US Letter' : paper}。`, '',
    `浏览器版本：${browser.version}。启动方式：${launch}（无界面）。`, '',
    '留白以可排版高度为基准。最后一页单列，留白不计为缺点。',
    '表格只允许在完整数据行之间分页。续页逐行核对原表和表头。有意外切块、页底标题、内容越界、页数不一致、文字差异或意外错误时，验收失败。', '',
    '| 样例 | 算法 | 总代价 | 结果 | PDF 页数 | 前几页留白 | 最后一页留白 | 表格各段行数 | 意外切块 | 页底标题 | 文字核对 |',
    '| --- | --- | ---: | --- | ---: | --- | ---: | --- | ---: | ---: | --- |'
  ];
  for (const row of rows) {
    const status = row.details.length ? '失败' : '通过';
    const link = row.pages ? `[${row.filename}](${relative(output, row.directory).split(sep).join('/')}/document.pdf)` : row.filename;
    const textStatus = row.textMatches === undefined ? '—' : row.textMatches ? '完全一致' : '有差异，见下方';
    lines.push(`| ${link} | ${row.strategy === 'optimal' ? '全局最优' : '贪心'} | ${row.cost?.toFixed(2) ?? '—'} | ${status} | ${row.pages ?? '—'} | ${row.whitespace?.slice(0, -1).join('、') || '—'} | ${row.whitespace?.at(-1) ?? '—'} | ${row.parts?.map(p => p.join('+')).join('、') || '—'} | ${row.splits ?? '—'} | ${row.orphans ?? '—'} | ${textStatus} |`);
  }
  for (const row of rows) {
    const details = [...row.details, ...(row.notes ?? [])];
    if (details.length) lines.push('', `## ${row.filename} · ${row.strategy}`, '', ...details.map(detail => '- ' + detail));
  }
  return lines.join('\n') + '\n';
}

execFileSync(python, ['-c', 'import pypdf, pymupdf'], { stdio: 'inherit' });

const names = letterDemo ? ['cedarway-readiness-report.html']
  : (await readdir(samples, { recursive: true })).filter(name => name.endsWith('.html')).sort();
if (!names.length) throw new Error('samples/ 下找不到 HTML 验收样例。');
await mkdir(output, { recursive: true });
const server = await startSampleServer();
let browser;
try {
  const executablePath = process.env.UNSLICED_CHROMIUM || undefined;
  const headless = true;
  browser = await chromium.launch({ executablePath, headless });
  const browserInfo = {
    version: browser.version(),
    launchMode: executablePath ? 'custom-executable' : 'playwright-default',
    headless
  };
  const rows = [];
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const name of names) {
    const path = name.split(sep).map(encodeURIComponent).join('/');
    for (const strategy of ['greedy-scored', 'optimal']) {
      rows.push(await checkSample(browser, base + '/' + path, name, strategy, undefined,
        name === 'table-long.html' && strategy === 'optimal'));
    }
  }
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const sections = [];
  for (let i = 0; i < rows.length; i += 2) {
    const pair = rows.slice(i, i + 2);
    sections.push('<h2>' + escape(pair[0].filename) + '</h2>');
    for (let n = 0; n < Math.max(...pair.map(row => row.images?.length ?? 0)); n++) {
      sections.push('<section>' + pair.map(row => {
        const image = row.images?.[n];
        const title = (row.strategy === 'optimal' ? '全局最优' : '贪心') + ' · 第 ' + (n + 1) + ' 页';
        return '<figure><figcaption>' + title + '</figcaption>' + (image ?
          '<img src="' + escape(relative(output, join(row.directory, image)).split(sep).join('/')) + '">' : '本版无此页') + '</figure>';
      }).join('') + '</section>');
    }
  }
  await writeFile(join(output,'comparison.html'), '<!doctype html><meta charset="utf-8"><title>Unsliced 逐页对比</title><style>body{background:#eef1f3;font:16px sans-serif;padding:1rem}section{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%}figcaption{padding:.5rem}</style>' + sections.join(''));
  const sweep = [];
  if (process.argv.includes('--sweep')) {
    for (const name of names.filter(name => name === 'invoice.html' || name.startsWith('table-'))) {
      for (const penalty of [0, 15, 30, 45]) {
        const row = penalty === 15 ? rows.find(r => r.filename === name && r.strategy === 'optimal')
          : await checkSample(browser, base + '/' + name, name, 'optimal', penalty);
        sweep.push({ ...row, penalty });
      }
    }
  }
  await writeFile(join(output, 'metrics.json'), JSON.stringify({ paper, rows, sweep, browser: browserInfo }, null, 2));
  const report = renderReport(rows, browserInfo);
  for (const row of sweep) {
    for (const error of row.details) process.stderr.write(row.filename + ' (' + row.penalty + '): ' + error + '\n');
  }
  await writeFile(join(output, 'report.md'), report);
  process.stdout.write(report);
  process.exitCode = [...rows, ...sweep].some(row => row.details.length) ? 1 : 0;
} finally {
  await browser?.close();
  server.close();
}
