import { Marked } from 'marked';
import { prepareDocument } from './document.mjs';

const $ = id => document.getElementById(id);
const controls = $('web-controls'), editor = $('markdown'), font = $('font');
const samples = $('samples'), loadSample = $('sample');
const renderButton = $('render'), printButton = $('print'), status = $('status');
const markdown = new Marked({ gfm: true });
const pathFor = name => './samples/' + name.split('/').map(encodeURIComponent).join('/');
let names = [], htmlSample = null, busy = false, didRender = false;

async function get(path, type = 'text') {
  const response = await fetch(path);
  if (!response.ok) throw new Error('无法载入：' + path);
  return response[type]();
}

function markdownOnly(text) {
  markdown.walkTokens(markdown.lexer(text), token => {
    if (token.type === 'html') throw new Error('本实验只接受 Markdown，不接受直接写入的 HTML。');
  });
  return prepareDocument({ markdown: text });
}

// Same root choice as MCP's create_pdf. Only the local, built-in sample list
// can take the HTML path; there is no HTML upload, URL, or pasted HTML entry.
function pickRoot() {
  const explicit = document.querySelectorAll('[data-unsliced-root]');
  if (explicit.length === 1) return explicit[0];
  const children = Array.from(document.body.children).filter(el => el.tagName !== 'STYLE');
  if (children.length === 1 && ['ARTICLE', 'MAIN', 'DIV', 'SECTION'].includes(children[0].tagName) &&
      !Array.from(document.body.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) return children[0];
  return document.body;
}

function addStyle(css) {
  const style = document.createElement('style');
  style.dataset.webDocument = '';
  style.textContent = css;
  document.head.append(style);
}

async function finishFonts() {
  document.body.getBoundingClientRect();
  await document.fonts.ready;
  if (font.value === 'B' && Array.from(document.fonts).some(face => face.status === 'error')) {
    throw new Error('字体下载失败，未继续分页。请重试。');
  }
}

async function layout(html) {
  for (const node of document.head.querySelectorAll('[data-web-document], #breakflow-print-styles')) node.remove();
  document.body.removeAttribute('style');
  controls.remove();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...doc.body.childNodes);
  for (const style of doc.head.querySelectorAll('style')) addStyle(style.textContent);
  const root = pickRoot();
  const han = /\p{Script=Han}/u.test(root.innerText);
  const start = performance.now();
  if (han) {
    const base = getComputedStyle(root).fontFamily;
    const family = '"Unsliced Sans SC", ' + base + (font.value === 'A'
      ? ', "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' : '');
    root.style.setProperty('font-family', family, 'important');
    root.setAttribute('data-web-cjk-root', '');
    addStyle(`body, [data-web-cjk-root] { font-family: ${family} !important; }`);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // Absolute URL also works inside BreakFlow's measurement frame.
    link.href = new URL(`./fonts/${font.value.toLowerCase()}.css`, location.href).href;
    link.dataset.webDocument = '';
    await new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = () => reject(new Error('字体样式载入失败。'));
      document.head.append(link);
    });
  }
  await finishFonts();
  const fontReadyMs = performance.now() - start;
  await Promise.all(Array.from(root.querySelectorAll('img'), async img => {
    try { await img.decode(); }
    catch { throw new Error('图片无法解码：' + (img.alt || '未命名图片')); }
  }));
  const { element, styles, ...plan } = await BreakFlow.createPaginator({
    strategy: 'optimal', optimal: BreakFlow.DEFAULT_OPTIMAL_OPTIONS, page: { format: 'A4' }
  }).paginate(root, { replaceOriginal: true, injectStyles: true });
  if (!plan.pageCount) throw new Error('内容没有可打印的正文。');
  await finishFonts();
  return { ...plan, fontReadyMs, han };
}

function invalidate() {
  window.webFeasibilityResult = null;
  printButton.disabled = true;
}

async function run(action) {
  if (busy) return;
  busy = true;
  invalidate();
  for (const control of [editor, font, samples, loadSample, renderButton]) control.disabled = true;
  status.textContent = '正在载入字体并分页……';
  try {
    const html = await action();
    window.webFeasibilityResult = await layout(html);
    const { pageCount, issues } = window.webFeasibilityResult;
    status.textContent = `预览：${pageCount} 页（A4，字体 ${font.value}）。` +
      (issues.length ? ` 有 ${issues.length} 条排版提示，打印前请核对预览。` : '');
    printButton.disabled = false;
    didRender = true;
  } catch (error) {
    document.body.replaceChildren();
    status.textContent = '无法预览：' + error.message;
  } finally {
    document.body.prepend(controls);
    for (const control of [editor, font, samples, renderButton]) control.disabled = false;
    loadSample.disabled = !samples.value;
    busy = false;
  }
}

function renderCurrent() {
  return run(() => htmlSample === null ? markdownOnly(editor.value.trim()) : prepareDocument({ html: htmlSample.trim() }));
}
renderButton.onclick = renderCurrent;
font.onchange = () => { if (didRender) renderCurrent(); };
editor.oninput = () => {
  htmlSample = null;
  invalidate();
  status.textContent = '内容已改动，请重新点击「分页预览」。';
};
samples.onchange = () => { loadSample.disabled = !samples.value; };
loadSample.onclick = () => run(async () => {
  const name = samples.value;
  if (!names.includes(name)) throw new Error('未知样例。');
  const source = await get(pathFor(name));
  htmlSample = name.endsWith('.html') ? source : null;
  editor.value = htmlSample === null ? source : '';
  editor.placeholder = htmlSample === null ? '' : `正在测试 HTML 样例：${name}（在此粘贴 Markdown 可切回）`;
  return htmlSample === null ? markdownOnly(source.trim()) : prepareDocument({ html: source.trim() });
});
printButton.onclick = () => { if (window.webFeasibilityResult) window.print(); };
get('./samples.json', 'json').then(list => {
  names = list;
  samples.append(...names.map(name => new Option(name, name)));
}).catch(error => { status.textContent = error.message; });
