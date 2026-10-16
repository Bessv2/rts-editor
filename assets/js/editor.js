// Visual site editor. Edits content/site.json through a live canvas.
import { publishToGitHub, checkAccess, listPublishedVersions, readPublishedVersion, saveCloudDraft, loadCloudDraft, gitBlobSha, PublishCancelled, codeChangedSince } from './publish.js';
import { kv, versions } from './store.js';
import { CONFIG, SITE, loadTheme, showFatal, siteAsset as toSiteAsset } from './config.js';
import { htmlToMarkdown, hasFormatting, stripHandlers } from './html-to-md.js';

// Refuse to run inside another site's frame (clickjacking protection;
// GitHub Pages can't send X-Frame-Options headers).
if (window.top !== window.self) {
  document.body.innerHTML = '<p style="padding:40px;font-family:system-ui">The editor can only be opened directly.</p>';
  throw new Error('Editor must not be framed');
}

// The site's theme (sections, renderer, page builder) comes from the live site.
let theme;
try {
  theme = await loadTheme();
} catch (err) {
  showFatal(err.message);
  throw err;
}
const {
  BLOCKS, STYLE_FIELDS, BLOCK_GROUPS, renderPage, renderSection, renderPostPage, postTitle, formatDate, themeCSS, fontsHref,
  getPath, setPath, esc, pageHref, rich, THEME_PRESETS, FONTS, icon, ICON_NAMES, SOCIAL, migrate, validate, POSTS_BASE, buildSite, staleFiles, safeSrc,
} = theme;
const siteAsset = (src) => toSiteAsset(src, safeSrc);
// Optional capabilities: older site themes don't have them, so each is checked before use.
const has = (feature) => Array.isArray(theme.FEATURES) && theme.FEATURES.includes(feature);
const anchorId = theme.anchorId || ((v) => String(v || '').replace(/^#/, '').replace(/[^\w-]/g, ''));

const DRAFT_KEY = 'rts-editor-draft';
const GH_KEY = 'rts-editor-github';
const CLIP_KEY = 'rts-editor-clipboard';
const DEFAULT_REPO = { owner: CONFIG.repo.owner, repo: CONFIG.repo.name, branch: CONFIG.repo.branch };
// Drafts, versions and GitHub settings belong to one site, in case the editor is pointed at another.
const SITE_KEY = `${SITE}|${CONFIG.repo.owner}/${CONFIG.repo.name}`;
const OPENED_AT = new Date();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = (p = 's') => `${p}-${Math.random().toString(36).slice(2, 9)}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

const state = {
  doc: null, page: 0, sel: null, tab: 'add', device: 'desktop',
  history: [], future: [], snap: '', published: '',
  open: new Set(), commitTimer: 0, ghToken: '', clipboard: null, post: null,
  el: null, // index of the selected element inside the selected section
  access: null, // { email, name } when the editor is behind a login (Cloudflare Access)
  base: '', // content/site.json version (git sha) this draft started from
};

// ---------------------------------------------------------------------------
// DOM helper
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
const put = (node, ...kids) => { node.append(...kids.filter((k) => k != null && k !== false)); return node; };
const ico = (name) => el('span', { 'data-icon': name, html: icon(name) });
function hydrateIcons(root = document) { $$('[data-icon]:empty', root).forEach((n) => { n.innerHTML = icon(n.dataset.icon); }); }

// ---------------------------------------------------------------------------
// Document helpers
const page = () => state.doc.pages[state.page];
const sections = () => page().sections;
const findSection = (id) => sections().find((s) => s.id === id);
const isChrome = (id) => id === '__header' || id === '__footer';
const targetFor = (id) => (isChrome(id) ? state.doc.site : findSection(id)?.data);

function newSection(type, overrides = {}) {
  return { id: uid(), type, data: { ...BLOCKS[type].defaults(), ...overrides } };
}

function sectionSummary(sec) {
  const d = sec.data || {};
  return d.heading || d.items?.[0]?.title || d.items?.[0]?.value || d.caption || d.text || '';
}

// ---------------------------------------------------------------------------
// History + drafts
function commit() {
  clearTimeout(state.commitTimer);
  state.commitTimer = 0;
  const s = JSON.stringify(state.doc);
  if (s === state.snap) return;
  state.history.push(state.snap);
  if (state.history.length > 150) state.history.shift();
  state.future = [];
  state.snap = s;
  saveDraft(s);
  updateTopbar();
  refreshChecksSoon();
}
function commitSoon() { clearTimeout(state.commitTimer); state.commitTimer = setTimeout(commit, 500); }
function flushCommit() { if (state.commitTimer) commit(); }

function saveDraft(s = JSON.stringify(state.doc)) {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* legacy draft location */ }
  const p = s === state.published ? kv.del('draft') : kv.set('draft', { savedAt: Date.now(), json: s, base: state.base, site: SITE_KEY });
  return p.catch(() => toast('Could not save your draft in this browser. Publish or download a backup to keep your work.', { error: true }));
}

// Versions of the live content this browser has started from or published,
// so an old copy served from the site's cache isn't mistaken for someone else's change.
async function setBase(sha) {
  if (!sha) return;
  state.base = sha;
  try {
    const known = (await kv.get('known-bases')) || [];
    if (!known.includes(sha)) await kv.set('known-bases', [sha, ...known].slice(0, 30));
  } catch { /* IndexedDB unavailable */ }
}

function restore(snap) {
  state.doc = JSON.parse(snap);
  state.snap = snap;
  state.page = Math.min(state.page, state.doc.pages.length - 1);
  if (state.sel && !isChrome(state.sel) && !findSection(state.sel)) state.sel = null;
  saveDraft(snap);
  refreshAll();
}
function undo() { flushCommit(); if (!state.history.length) return; state.future.push(state.snap); restore(state.history.pop()); }
function redo() { if (!state.future.length) return; state.history.push(state.snap); restore(state.future.pop()); }

// ---------------------------------------------------------------------------
// Canvas
const frame = $('#canvas');
const cdoc = () => frame.contentDocument;

function canvasHTML() {
  const t = state.doc.theme || {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <base href="${esc(`${SITE}/`)}">
    <link id="theme-fonts" rel="stylesheet" href="${esc(fontsHref(t))}">
    <link rel="stylesheet" href="${esc(`${SITE}/assets/css/site.css`)}"><link rel="stylesheet" href="${esc(new URL('assets/css/editor-canvas.css', location.href).href)}">
    <style id="theme-vars">${themeCSS(t)}</style></head>
    <body class="edit-mode"><div id="app"></div></body></html>`;
}

function initCanvas() {
  return new Promise((resolve) => {
    frame.addEventListener('load', function onLoad() {
      const d = cdoc();
      if (!d?.getElementById('app')) return; // initial about:blank
      frame.removeEventListener('load', onLoad);
      d.addEventListener('click', onCanvasClick, true);
      d.addEventListener('input', onCanvasInput);
      d.addEventListener('keydown', onCanvasKey);
      d.addEventListener('paste', onCanvasPaste);
      d.addEventListener('focusin', onCanvasFocusIn);
      d.addEventListener('focusout', onCanvasFocusOut);
      d.addEventListener('submit', (e) => e.preventDefault(), true);
      d.addEventListener('dragstart', onCanvasDragStart);
      d.addEventListener('dragenter', onCanvasDragOver);
      d.addEventListener('dragover', onCanvasDragOver);
      d.addEventListener('drop', onCanvasDrop);
      d.addEventListener('dragend', endCanvasDrag);
      d.body.dataset.device = state.device;
      resolve();
    });
    frame.srcdoc = canvasHTML();
  });
}

function makeEditable(root) {
  $$('[data-edit]', root).forEach((n) => {
    try { n.contentEditable = 'plaintext-only'; } catch { n.contentEditable = 'true'; }
    n.spellcheck = true;
  });
}

function renderCanvas({ keepScroll = true } = {}) {
  const d = cdoc();
  if (!d?.getElementById('app')) return;
  const y = d.defaultView.scrollY;
  const app = d.getElementById('app');
  const post = state.post && findPost(state.post);
  app.innerHTML = post ? renderPostPage(state.doc, post, { preview: true }) : renderPage(state.doc, state.page, { edit: true });
  makeEditable(app);
  addInserts(app);
  if (!post && !sections().length) {
    d.querySelector('main')?.insertAdjacentHTML('beforeend', `<div class="ed-empty"><button type="button" data-tool="insert" data-at="start">${icon('plus')}<span>Add your first section</span></button></div>`);
  }
  decorateSelection();
  markSamples();
  d.defaultView.scrollTo(0, keepScroll ? y : 0);
}

function refreshSection(id) {
  if (isChrome(id)) { renderCanvas(); return; }
  const d = cdoc();
  const old = d.querySelector(`[data-section-id="${CSS.escape(id)}"]`);
  const sec = findSection(id);
  if (!old || !sec) { renderCanvas(); return; }
  const tmp = d.createElement('div');
  tmp.innerHTML = renderSection(sec, { edit: true, site: state.doc });
  const fresh = tmp.firstElementChild;
  old.replaceWith(fresh);
  makeEditable(fresh);
  addInserts(fresh);
  decorateSelection();
  markSamples();
}

function applyTheme() {
  const d = cdoc();
  const t = state.doc.theme || {};
  d.getElementById('theme-vars').textContent = themeCSS(t);
  const link = d.getElementById('theme-fonts');
  const href = fontsHref(t);
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function decorateSelection() {
  const d = cdoc();
  $$('.ed-chip, .ed-tools, .ed-el-tools', d).forEach((n) => n.remove());
  $$('.is-selected, .is-el-selected', d).forEach((n) => n.classList.remove('is-selected', 'is-el-selected'));
  if (!state.sel) return;
  const node = d.querySelector(`[data-section-id="${CSS.escape(state.sel)}"]`);
  if (!node) return;
  node.classList.add('is-selected');
  const elNode = state.el != null ? node.querySelector(`[data-el="${state.el}"]`) : null;
  if (elNode) {
    const count = elementsOf(findSection(state.sel)).length;
    elNode.classList.add('is-el-selected');
    const et = d.createElement('div');
    et.className = 'ed-el-tools';
    et.innerHTML = `<span class="ed-grip" draggable="true" data-drag="el" title="Drag to move (also into another section)">${icon('grip')}</span>`
      + [['el-up', 'chevron-up', 'Move up', state.el === 0], ['el-down', 'chevron-down', 'Move down', state.el === count - 1],
        ['el-copy', 'copy', 'Duplicate'], ['el-delete', 'trash', 'Remove']]
        .map(([t, ic, title, dis]) => `<button type="button" data-tool="${t}" title="${title}"${dis ? ' disabled' : ''}>${icon(ic)}</button>`).join('');
    elNode.append(et);
  }
  const chip = d.createElement('div');
  chip.className = 'ed-chip';
  chip.textContent = (!isChrome(state.sel) && findSection(state.sel)?.label) || node.dataset.label;
  node.append(chip);
  if (isChrome(state.sel)) return;
  const i = sections().findIndex((s) => s.id === state.sel);
  const hidden = findSection(state.sel).hidden;
  const tools = d.createElement('div');
  tools.className = 'ed-tools';
  tools.innerHTML = `<span class="ed-grip" draggable="true" data-drag="section" title="Drag to move">${icon('grip')}</span>` + [
    ['up', 'chevron-up', 'Move up', i === 0], ['down', 'chevron-down', 'Move down', i === sections().length - 1],
    ['duplicate', 'copy', 'Duplicate'], ['hide', hidden ? 'eye' : 'eye-off', hidden ? 'Show on live site' : 'Hide on live site'],
    ...(Object.keys(ELEMENTS).length ? [['elements', 'plus', 'Add text, image or button to this section']] : []),
    ['copy', 'clipboard2', 'Copy (paste on any page)'], ['save', 'bookmark', 'Save to reuse later'],
    ['settings', 'sliders', 'Edit settings'], ['delete', 'trash', 'Delete'],
  ].map(([t, ic, title, dis]) => `<button type="button" data-tool="${t}" title="${title}"${dis ? ' disabled' : ''}>${icon(ic)}</button>`).join('');
  node.append(tools);
}

// “+” buttons at the top and bottom edge of every section add a section right there.
function addInserts(root) {
  if (state.post || !root) return;
  const nodes = root.matches?.('[data-section-id]') ? [root] : $$('[data-section-id]', root);
  for (const n of nodes) {
    if (isChrome(n.dataset.sectionId)) continue;
    for (const at of ['before', 'after']) {
      const b = n.ownerDocument.createElement('button');
      b.type = 'button';
      b.className = `ed-ins ed-ins--${at}`;
      b.dataset.tool = 'insert';
      b.dataset.at = at;
      b.title = at === 'before' ? 'Add a section above' : 'Add a section below';
      b.innerHTML = `${icon('plus')}<span>Add section</span>`;
      n.append(b);
    }
  }
}

// Drag and drop on the page: sections by the grip in their toolbar, elements
// by the grip in theirs (onto another element, or into any section).
let drag = null; // { kind: 'section', id } or { kind: 'el', sec, i }
function onCanvasDragStart(e) {
  const g = e.target.closest?.('[data-drag]');
  if (!g || !state.sel) { if (!e.target.closest?.('[data-edit]')) e.preventDefault(); return; }
  drag = g.dataset.drag === 'el' && state.el != null ? { kind: 'el', sec: state.sel, i: state.el } : { kind: 'section', id: state.sel };
  const node = drag.kind === 'el' ? g.closest('[data-el]') : g.closest('[data-section-id]');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.kind);
  try { e.dataTransfer.setDragImage(node, 24, 24); } catch { /* not supported */ }
  node.classList.add('ed-dragging');
}

function dropTarget(e) {
  if (!drag) return null;
  const sec = e.target.closest?.('[data-section-id]');
  if (!sec || isChrome(sec.dataset.sectionId)) return null;
  if (drag.kind === 'section') {
    const r = sec.getBoundingClientRect();
    return { node: sec, before: e.clientY < r.top + r.height / 2 };
  }
  const elNode = e.target.closest('[data-el]');
  if (elNode) {
    const r = elNode.getBoundingClientRect();
    const wide = r.width > elNode.parentElement.getBoundingClientRect().width * 0.8;
    return { node: elNode, before: wide ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2, side: !wide };
  }
  return { node: sec, into: true };
}

function clearDrop() {
  $$('.ed-drop-before, .ed-drop-after, .ed-drop-into', cdoc()).forEach((n) => n.classList.remove('ed-drop-before', 'ed-drop-after', 'ed-drop-into', 'ed-drop-side'));
}

function onCanvasDragOver(e) {
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDrop();
  t.node.classList.add(t.into ? 'ed-drop-into' : t.before ? 'ed-drop-before' : 'ed-drop-after');
  if (t.side) t.node.classList.add('ed-drop-side');
}

function onCanvasDrop(e) {
  const t = dropTarget(e);
  clearDrop();
  if (!t) return;
  e.preventDefault();
  if (drag.kind === 'section') {
    const list = sections();
    const targetId = t.node.dataset.sectionId;
    if (targetId === drag.id) { endCanvasDrag(); return; }
    const [moved] = list.splice(list.findIndex((x) => x.id === drag.id), 1);
    list.splice(list.findIndex((x) => x.id === targetId) + (t.before ? 0 : 1), 0, moved);
    const id = moved.id;
    // Redraw after the browser has finished the drag (dragend), not while the dragged node is in use.
    afterDrag(() => {
      commit(); renderCanvas(); renderPanel();
      toast('Section moved', { action: 'Undo', onAction: undo });
      setTimeout(() => scrollToSection(id), 20);
    });
    return;
  }
  const from = findSection(drag.sec);
  const item = elementsOf(from)[drag.i];
  const toId = t.node.closest('[data-section-id]').dataset.sectionId;
  const to = findSection(toId);
  if (!item || !to) { endCanvasDrag(); return; }
  let j = t.into ? elementsOf(to).length : Number(t.node.dataset.el) + (t.before ? 0 : 1);
  from.data.elements.splice(drag.i, 1);
  if (from === to && drag.i < j) j -= 1;
  to.data.elements = elementsOf(to);
  to.data.elements.splice(j, 0, item);
  afterDrag(() => {
    state.open.forEach((k) => { if (/:elements\./.test(k)) state.open.delete(k); });
    state.sel = toId;
    state.el = j;
    state.open.add(elKey(toId, j));
    commit(); renderCanvas(); renderInspector();
    if (state.tab === 'layers') renderPanel();
  });
}

let pendingRedraw = null;
function afterDrag(fn) {
  pendingRedraw = fn;
  setTimeout(() => { if (pendingRedraw === fn) endCanvasDrag(); }, 0);
}

function endCanvasDrag() {
  drag = null;
  clearDrop();
  $$('.ed-dragging', cdoc()).forEach((n) => n.classList.remove('ed-dragging'));
  const fn = pendingRedraw;
  pendingRedraw = null;
  fn?.();
}

function insertAt(btn) {
  if (btn.dataset.at === 'start') { openQuickAdd(0); return; }
  const id = btn.closest('[data-section-id]')?.dataset.sectionId;
  const i = sections().findIndex((s) => s.id === id);
  openQuickAdd(i === -1 ? sections().length : btn.dataset.at === 'before' ? i : i + 1);
}

function scrollToSection(id, flash = false) {
  const node = cdoc()?.querySelector(`[data-section-id="${CSS.escape(id)}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (flash) { node.classList.add('ed-flash'); setTimeout(() => node.classList.remove('ed-flash'), 1000); }
}

function onCanvasClick(e) {
  const tool = e.target.closest('[data-tool]');
  if (tool) {
    e.preventDefault();
    e.stopPropagation();
    if (tool.dataset.tool === 'insert') { insertAt(tool); return; }
    if (!tool.disabled) runTool(tool.dataset.tool, state.sel);
    return;
  }
  if (e.target.closest('a, summary, button')) e.preventDefault();
  const sec = e.target.closest('[data-section-id]');
  const id = sec?.dataset.sectionId || null;
  const elNode = id && !isChrome(id) ? e.target.closest('[data-el]') : null;
  if (elNode) {
    const i = Number(elNode.dataset.el);
    if (id !== state.sel || i !== state.el) selectElement(id, i);
    // An empty image opens the library straight away.
    if (e.target.closest('.figure__empty') && elementsOf(findSection(id))[i]?.type === 'image') {
      openMediaPicker((src) => {
        const item = elementsOf(findSection(id))[i];
        if (!item) return;
        item.image = src;
        commit(); refreshSection(id); renderInspector();
      });
    }
    return;
  }
  if (id !== state.sel) select(id);
  else if (state.el != null) { state.el = null; renderInspector(); decorateSelection(); }
}

function onCanvasInput(e) {
  const n = e.target.closest?.('[data-edit]');
  if (!n) return;
  const id = n.closest('[data-section-id]')?.dataset.sectionId;
  const target = targetFor(id);
  if (!target) return;
  let value = n.innerText;
  value = n.hasAttribute('data-ml') ? value.replace(/\n$/, '') : value.replace(/\s*\n\s*/g, ' ');
  if (value === '' && n.innerHTML !== '') n.innerHTML = ''; // so the placeholder reappears
  setPath(target, n.dataset.edit, value);
  if (state.sel !== id) select(id, { quiet: true });
  const input = $(`#inspector [data-path="${CSS.escape(n.dataset.edit)}"]`);
  if (input && document.activeElement !== input) input.value = value;
  if (id === '__header' && n.dataset.edit === 'name') {
    const fb = cdoc().querySelector('.site-footer .brand__name');
    if (fb) fb.textContent = value;
  }
  commitSoon();
}

// Formatted paragraphs show their raw **markdown** while being edited.
function richTarget(e) {
  const n = e.target.closest?.('[data-rich]');
  const id = n?.closest('[data-section-id]')?.dataset.sectionId;
  return n && id ? { n, raw: String(getPath(targetFor(id), n.dataset.edit) ?? '') } : null;
}
function onCanvasFocusIn(e) {
  const r = richTarget(e);
  if (r && r.n.textContent !== r.raw) r.n.textContent = r.raw;
}
function onCanvasFocusOut(e) {
  flushCommit();
  const r = richTarget(e);
  if (r) r.n.innerHTML = r.n.hasAttribute('data-md') && theme.markdown ? theme.markdown(r.raw, safeSrc) : rich(r.raw);
}

function onCanvasKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { onGlobalKey(e); return; }
  const n = e.target.closest?.('[data-edit]');
  if (n) {
    if (e.key === 'Escape' || (e.key === 'Enter' && !n.hasAttribute('data-ml'))) { e.preventDefault(); n.blur(); }
    if ((e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key)) { /* let browser undo inside text */ return; }
    return;
  }
  onGlobalKey(e);
}

function onCanvasPaste(e) {
  const n = e.target.closest?.('[data-edit]');
  if (!n || n.contentEditable === 'plaintext-only') return;
  e.preventDefault();
  cdoc().execCommand('insertText', false, e.clipboardData.getData('text/plain'));
}

// ---------------------------------------------------------------------------
// Selection + section operations
function select(id, { quiet = false, scroll = false } = {}) {
  flushCommit();
  if (id !== state.sel) state.el = null;
  state.sel = id;
  decorateSelection();
  renderInspector();
  if (state.tab === 'layers') renderPanel();
  if (scroll && id) scrollToSection(id);
  if (!quiet && id && isChrome(id)) { /* header/footer use the site panel */ }
}

function insertIndex() {
  const i = sections().findIndex((s) => s.id === state.sel);
  return i === -1 ? sections().length : i + 1;
}

function addSection(type, at = null) {
  insertSection(newSection(type, type === 'hero' && state.page > 0 ? { layout: 'center', pad: 'normal' } : {}), `${BLOCKS[type].label} added`, at);
}

// Inserts a copy of a section at position `at`, or after the selection (or at the end).
function insertSection(section, message, at = null) {
  const sec = clone(section);
  sec.id = uid();
  state.el = null;
  sections().splice(at ?? (state.sel === '__header' ? 0 : insertIndex()), 0, sec);
  commit();
  state.sel = sec.id;
  renderCanvas();
  renderInspector();
  renderPanel();
  setTimeout(() => scrollToSection(sec.id, true), 30);
  toast(message || `${BLOCKS[sec.type]?.label || 'Section'} added`);
}

function getClipboard() {
  if (state.clipboard) return state.clipboard;
  try { return JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { return null; }
}

function copySection(id) {
  const sec = findSection(id);
  if (!sec) return;
  state.clipboard = clone(sec);
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(sec)); } catch { /* too large; memory copy still works */ }
  toast(`${BLOCKS[sec.type].label} copied. Paste it on any page from the Add tab or with Ctrl+V.`);
  if (state.tab === 'add') renderPanel();
}

function pasteSection() {
  const clip = getClipboard();
  if (clip && BLOCKS[clip.type]) insertSection(clip, `${BLOCKS[clip.type].label} pasted`);
}

function saveSection(id) {
  const sec = findSection(id);
  if (!sec) return;
  const name = prompt('Name this saved section', sectionSummary(sec) || BLOCKS[sec.type].label);
  if (name === null) return;
  state.doc.saved ||= [];
  state.doc.saved.push({ id: uid('saved'), name: name.trim() || BLOCKS[sec.type].label, section: clone(sec) });
  commit();
  if (state.tab === 'add') renderPanel();
  toast('Saved. Find it at the top of the Add tab.');
}

function runTool(tool, id) {
  const list = sections();
  const i = list.findIndex((s) => s.id === id);
  if (tool.startsWith('el-')) { if (state.el != null) elementTool(tool, id, state.el); return; }
  if (tool === 'elements') { openElementPicker(id); return; }
  if (tool === 'add') { openQuickAdd(i === -1 ? list.length : i + 1); return; }
  if (tool === 'copy') { copySection(id); return; }
  if (tool === 'save') { saveSection(id); return; }
  if (tool === 'settings') { $('#inspector').scrollTop = 0; $('#inspector .in, #inspector textarea')?.focus(); return; }
  if (i === -1) return;
  if (tool === 'up' || tool === 'down') {
    const j = tool === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    commit(); renderCanvas(); renderPanel();
    setTimeout(() => scrollToSection(id), 20);
  } else if (tool === 'duplicate') {
    const copy = clone(list[i]);
    copy.id = uid();
    list.splice(i + 1, 0, copy);
    state.sel = copy.id;
    commit(); renderCanvas(); renderPanel(); renderInspector();
    setTimeout(() => scrollToSection(copy.id, true), 20);
  } else if (tool === 'hide') {
    list[i].hidden = !list[i].hidden;
    commit(); refreshSection(id); renderPanel(); renderInspector();
    toast(list[i].hidden ? 'Section hidden on the live site' : 'Section visible again');
  } else if (tool === 'delete') {
    const label = BLOCKS[list[i].type]?.label || 'Section';
    list.splice(i, 1);
    state.sel = null;
    commit(); renderCanvas(); renderPanel(); renderInspector();
    toast(`${label} deleted`, { action: 'Undo', onAction: undo });
  }
}

// ---------------------------------------------------------------------------
// Elements: headings, text, images, buttons, lines and space that can be added
// to any section (site feature "elements"). They live in data.elements.
const ELEMENTS = (has('elements') && theme.ELEMENTS) || {};
const ELEMENT_HINTS = { heading: 'A title', text: 'Paragraphs, lists and links', image: 'A photo or picture', button: 'A link that stands out', feature: 'Icon, title and text', checklist: 'Points with ticks', quote: 'A quote that stands out', video: 'YouTube or Vimeo', review: 'Ask for a Google review', hours: 'Your opening hours', divider: 'A thin line', spacer: 'Empty space' };
const elementsOf = (sec) => (Array.isArray(sec?.data?.elements) ? sec.data.elements : []);
const elKey = (secId, i) => `${secId}:elements.${i}`;

function elementSummary(e) {
  const t = String(e.text || e.label || e.caption || e.alt || '').replace(/[*_`#>[\]()!]/g, '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 38 ? `${t.slice(0, 38)}…` : t) : ELEMENTS[e.type]?.label || 'Element';
}

// Selects element i of a section: highlights it on the page and opens it in the panel.
function selectElement(secId, i, { scroll = false } = {}) {
  if (state.sel !== secId) select(secId);
  state.el = i;
  // Only the selected element stays open in the panel.
  state.open.forEach((k) => { if (k.startsWith(`${secId}:elements.`)) state.open.delete(k); });
  if (i != null) state.open.add(elKey(secId, i));
  renderInspector();
  decorateSelection();
  if (i == null) return;
  setTimeout(() => {
    $(`#inspector [data-el-card="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (scroll) cdoc()?.querySelector(`[data-section-id="${CSS.escape(secId)}"] [data-el="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 30);
}

function addElement(secId, type) {
  const sec = findSection(secId);
  if (!sec || !ELEMENTS[type]) return;
  sec.data.elements = [...elementsOf(sec), ELEMENTS[type].defaults()];
  const i = sec.data.elements.length - 1;
  commit();
  refreshSection(secId);
  selectElement(secId, i, { scroll: true });
  // Headings and text are ready to type over.
  setTimeout(() => {
    const n = cdoc()?.querySelector(`[data-section-id="${CSS.escape(secId)}"] [data-el="${i}"] [data-edit]`);
    if (n && (type === 'heading' || type === 'text')) {
      n.focus();
      cdoc().getSelection()?.selectAllChildren(n);
    }
  }, 60);
  toast(`${ELEMENTS[type].label} added`);
}

function elementTool(tool, secId, i) {
  const sec = findSection(secId);
  const list = elementsOf(sec);
  if (!list[i]) return;
  const open = (j) => { state.open.forEach((k) => { if (k.startsWith(`${secId}:elements.`)) state.open.delete(k); }); if (j != null) state.open.add(elKey(secId, j)); };
  let next = i;
  if (tool === 'el-up' || tool === 'el-down') {
    const j = tool === 'el-up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    next = j;
  } else if (tool === 'el-copy') {
    list.splice(i + 1, 0, clone(list[i]));
    next = i + 1;
  } else if (tool === 'el-delete') {
    const label = ELEMENTS[list[i].type]?.label || 'Element';
    list.splice(i, 1);
    next = null;
    toast(`${label} removed`, { action: 'Undo', onAction: undo });
  } else return;
  open(next);
  state.el = next;
  commit();
  refreshSection(secId);
  renderInspector();
}

function openElementPicker(secId) {
  const sec = findSection(secId);
  if (!sec) return;
  openModal('Add to this section', el('div', {},
    el('p', {}, `Adds below the content of “${sec.label || BLOCKS[sec.type].label}”. Click it on the page afterwards to type or change it.`),
    el('div', { class: 'el-tiles' }, Object.entries(ELEMENTS).map(([type, e]) =>
      el('button', { type: 'button', class: 'el-tile', onclick: () => { closeModal(); addElement(secId, type); } },
        ico(e.icon), el('strong', {}, e.label), el('small', {}, ELEMENT_HINTS[type] || ''))))));
}

// The “Elements” group in the section panel. Cards can be dragged to reorder.
let cardDrag = null;
function elementsGroup(sec) {
  const list = elementsOf(sec);
  const inner = el('div', { class: 'els' },
    el('p', { class: 'p-hint' }, 'Add your own headings, text, images and buttons below this section’s content.'),
    el('div', { class: 'el-add' }, Object.entries(ELEMENTS).map(([type, e]) =>
      el('button', { type: 'button', class: 'el-add__btn', title: `Add ${e.label.toLowerCase()}`, onclick: () => addElement(sec.id, type) }, ico(e.icon), e.label))));
  const items = el('div', { class: 'list-f' });
  list.forEach((item, i) => {
    const def = ELEMENTS[item?.type];
    if (!def) return;
    const isOpen = state.open.has(elKey(sec.id, i));
    const btn = (tool, ic, title, dis) => el('button', { type: 'button', class: `ed-icon-btn ed-icon-btn--sm${tool === 'el-delete' ? ' ed-icon-btn--danger' : ''}`, title, disabled: !!dis, onclick: () => elementTool(tool, sec.id, i) }, ico(ic));
    const head = el('div', { class: 'list-item__head', onclick: (e) => {
      if (e.target.closest('button')) return;
      if (isOpen) { state.open.delete(elKey(sec.id, i)); state.el = null; renderInspector(); decorateSelection(); } else selectElement(sec.id, i, { scroll: true });
    } },
    el('span', { class: 'el-grip', title: 'Drag to reorder' }, ico('grip')), el('span', { class: 'chev' }, ico('chevron-right')), el('span', { class: 'el-ico' }, ico(def.icon)), el('span', { class: 't' }, elementSummary(item)),
    btn('el-up', 'chevron-up', 'Move up', i === 0), btn('el-down', 'chevron-down', 'Move down', i === list.length - 1),
    btn('el-copy', 'copy', 'Duplicate'), btn('el-delete', 'trash', 'Remove'));
    const node = el('div', { class: `list-item${isOpen ? ' is-open' : ''}${state.el === i ? ' is-sel' : ''}`, 'data-el-card': String(i),
      ondragenter: (e) => { if (cardDrag != null) e.preventDefault(); },
      ondragover: (e) => {
        if (cardDrag == null) return;
        e.preventDefault();
        if (cardDrag === i) return;
        const r = node.getBoundingClientRect();
        node.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
        node.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
      },
      ondragleave: () => node.classList.remove('drop-before', 'drop-after'),
      ondrop: (e) => {
        e.preventDefault();
        const before = node.classList.contains('drop-before');
        node.classList.remove('drop-before', 'drop-after');
        if (cardDrag == null || cardDrag === i) return;
        const [moved] = list.splice(cardDrag, 1);
        let j = i + (before ? 0 : 1);
        if (cardDrag < j) j -= 1;
        list.splice(j, 0, moved);
        cardDrag = null;
        state.open.forEach((k) => { if (k.startsWith(`${sec.id}:elements.`)) state.open.delete(k); });
        state.el = j;
        state.open.add(elKey(sec.id, j));
        commit(); refreshSection(sec.id); renderInspector();
      },
      ondragend: () => { cardDrag = null; } }, head);
    // The card's header is the handle (its fields stay selectable as normal).
    head.draggable = true;
    head.addEventListener('dragstart', (e) => { cardDrag = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'element'); });
    if (isOpen) {
      const body = el('div', { class: 'list-item__body' });
      renderFields(body, def.fields, sec.data, () => refreshSection(sec.id), `elements.${i}.`);
      node.append(body);
    }
    items.append(node);
  });
  if (list.length) inner.append(items);
  return el('details', { class: 'insp-group insp-group--els', open: true },
    el('summary', {}, el('span', {}, 'Elements', list.length ? el('span', { class: 'badge' }, String(list.length)) : null), el('span', { class: 'chev' }, ico('chevron-down'))), inner);
}

// ---------------------------------------------------------------------------
// Inspector (right panel)
const SITE_FIELDS = [
  { key: 'name', label: 'Business name', type: 'text' },
  { key: 'logo', label: 'Logo image', type: 'image', help: 'Optional. Wide logos look best around 36px tall.' },
  { key: 'logoIcon', label: 'Logo icon (when no image)', type: 'icon', when: (d) => !d.logo },
  { key: 'headerStyle', label: 'Header style', type: 'segmented', options: [['light', 'Light'], ['dark', 'Dark']] },
  { key: 'headerCta', label: 'Header button', type: 'button' },
  { key: 'tagline', label: 'Footer tagline', type: 'textarea' },
  { key: 'footerText', label: 'Footer note', type: 'text' },
];

function renderInspector() {
  const box = $('#inspector');
  const scroll = box.scrollTop;
  box.replaceChildren();
  if (state.post) {
    box.append(el('div', { class: 'p-head' }, el('h2', {}, ico('pen'), 'Writing tips')), el('div', { class: 'p-body' },
      el('p', { class: 'p-hint' }, 'The preview updates as you type. Use the toolbar above the text box, or type these yourself:'),
      el('div', { class: 'md-cheats' }, [
        ['**bold**', 'bold'], ['*italic*', 'italic'], ['[text](https://…)', 'link'], ['## Heading', 'section heading'],
        ['- item', 'bullet list'], ['1. item', 'numbered list'], ['> quote', 'quote'], ['![caption](image)', 'image'], ['---', 'divider line'],
        ...(has('code') ? [['`code`', 'code'], ['```', 'code block (on its own line before and after)']] : []),
        ...(has('callouts') ? [['> [!TIP]', 'tip box (also [!NOTE], [!WARNING])']] : []),
      ].map(([code, what]) => el('div', {}, el('code', {}, code), el('span', {}, what)))),
      el('p', { class: 'p-hint', style: 'margin-top:14px' }, 'Leave a blank line between paragraphs. Press Publish when you are ready for it to go live.'),
      el('p', { class: 'p-hint' }, 'Writing in Word or Google Docs? Copy and paste: headings, lists, bold, italic and links come along.')));
    return;
  }
  if (!state.sel) {
    box.append(el('div', { class: 'empty' },
      el('span', { class: 'empty__icon' }, ico('sparkle')),
      el('h3', {}, 'Select something to edit'),
      el('p', {}, 'Click any section on the page. Click text to type directly on the page.'),
      el('div', { class: 'kbd-list' },
        el('div', {}, 'Undo / Redo', el('span', {}, el('kbd', {}, 'Ctrl Z'), ' ', el('kbd', {}, 'Ctrl ⇧ Z'))),
        el('div', {}, 'Delete section', el('kbd', {}, 'Del')),
        el('div', {}, 'Deselect', el('kbd', {}, 'Esc')),
        el('div', {}, 'Save draft', el('kbd', {}, 'Ctrl S')), el('div', {}, 'Jump to a page, section, post or setting', el('kbd', {}, 'Ctrl K')))));
    return;
  }
  if (isChrome(state.sel)) {
    box.append(el('div', { class: 'p-head' }, el('h2', {}, ico('layout'), 'Header & footer')));
    const body = el('div', { class: 'p-body' }, el('p', { class: 'p-hint' }, 'These appear on every page. Navigation links come from your Pages.'));
    renderFields(body, SITE_FIELDS, state.doc.site, () => renderCanvas());
    box.append(body);
    box.scrollTop = scroll;
    return;
  }
  const sec = findSection(state.sel);
  const block = BLOCKS[sec.type];
  box.append(el('div', { class: 'p-head' },
    el('h2', {}, ico(block.icon), block.label),
    el('div', { class: 'insp-actions' },
      el('button', { class: 'ed-icon-btn ed-icon-btn--sm', title: sec.hidden ? 'Show on live site' : 'Hide on live site', onclick: () => runTool('hide', sec.id) }, ico(sec.hidden ? 'eye' : 'eye-off')),
      el('button', { class: 'ed-icon-btn ed-icon-btn--sm', title: 'Duplicate', onclick: () => runTool('duplicate', sec.id) }, ico('copy')),
      el('button', { class: 'ed-icon-btn ed-icon-btn--sm ed-icon-btn--danger', title: 'Delete', onclick: () => runTool('delete', sec.id) }, ico('trash')))));
  // A name only the editor shows, so sections are easy to tell apart (“Spring promo”).
  box.append(el('div', { class: 'f sec-name' }, el('label', {}, 'Section name ', el('small', {}, '(only you see this)')),
    el('input', { class: 'in', 'data-path': '__label', value: sec.label || '', placeholder: block.label, maxlength: 60, oninput: (e) => {
      if (e.target.value.trim()) sec.label = e.target.value; else delete sec.label;
      commitSoon();
      decorateSelection();
      if (state.tab === 'layers') renderPanel();
    } })));
  const groups = [['Content', block.fields, true], ['Section style', STYLE_FIELDS, true]];
  for (const [title, fields, open] of groups) {
    const inner = el('div');
    renderFields(inner, fields, sec.data, () => refreshSection(sec.id));
    box.append(el('details', { class: 'insp-group', open }, el('summary', {}, title, el('span', { class: 'chev' }, ico('chevron-down'))), inner));
    if (title === 'Content' && Object.keys(ELEMENTS).length) box.append(elementsGroup(sec));
  }
  box.scrollTop = scroll;
}

// Builds form controls for a field schema. `onRender` refreshes the canvas.
function renderFields(container, fields, target, onRender, base = '', rebuild = renderInspector) {
  const change = (path, value, { structural = false, soon = false } = {}) => {
    setPath(target, path, value);
    onRender();
    if (soon) commitSoon(); else commit();
    if (structural) rebuild();
  };
  for (const f of fields) {
    if (f.when && !f.when(base ? getPath(target, base.slice(0, -1)) : target)) continue;
    const path = base + (f.key || '');
    const val = f.key ? getPath(target, path) : undefined;
    container.append(fieldControl(f, path, val, change, target, onRender));
  }
}

function linkSuggestions() {
  let dl = $('#link-suggest');
  if (!dl) { dl = el('datalist', { id: 'link-suggest' }); document.body.append(dl); }
  const opts = [];
  state.doc.pages.forEach((p, i) => opts.push([pageHref(p, i), `Page: ${p.title}${p.draft && i > 0 ? ' (unpublished)' : ''}`]));
  (state.doc.posts || []).forEach((p) => opts.push([`/${POSTS_BASE}/${p.slug}/`, `Post: ${postTitle(p)}`]));
  state.doc.pages.forEach((p, i) => p.sections.forEach((s) => {
    const id = anchorId(s.data?.anchor);
    if (!id) return;
    if (i === state.page) opts.push([`#${id}`, `Section on this page: ${id}`]);
    else opts.push([`${pageHref(p, i)}#${id}`, `Section on ${p.title}: ${id}`]);
  }));
  if (state.doc.site.email) opts.push([`mailto:${state.doc.site.email}`, 'Email']);
  if (state.doc.site.phone) opts.push([`tel:${state.doc.site.phone.replace(/[^+\d]/g, '')}`, 'Phone']);
  dl.replaceChildren(...[...new Map(opts)].map(([v, l]) => el('option', { value: v, label: l })));
  return 'link-suggest';
}

// ---------------------------------------------------------------------------
// Link picker: choose a page, a section, a post, email or phone instead of
// typing addresses. `from` is the page the link sits on (-1 when it shows on
// every page or in a post): sections on that page are linked as #anchor,
// anywhere else with their page's address in front.
const pageOfTarget = (target) => (state.doc.pages[state.page]?.sections.some((s) => s.data === target) ? state.page : -1);

// A readable anchor (“our-services”) no other section on the page uses.
function uniqueAnchor(page, sec) {
  const taken = new Set(['main', ...page.sections.filter((s) => s !== sec).map((s) => anchorId(s.data?.anchor)).filter(Boolean)]);
  const base = slugify(sec.label || sectionSummary(sec) || BLOCKS[sec.type]?.label || 'section').slice(0, 40).replace(/-+$/, '') || 'section';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// Typed addresses: example.com → https://example.com, name@example.com → mailto:, phone numbers → tel:.
function normalizeLink(v) {
  const t = String(v || '').trim();
  if (!t || /^(https?:|mailto:|tel:|\/|#)/i.test(t)) return t;
  if (/^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i.test(t)) return `mailto:${t}`;
  if (/^\+?[\d\s().-]{7,}$/.test(t)) return `tel:${t.replace(/[^+\d]/g, '')}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(t)) return `https://${t}`;
  return '';
}

function openLinkPicker(onPick, { from = -1, current = '' } = {}) {
  const pick = (href) => { closeModal(); onPick(href); };
  const items = []; // { node, text, page } for the search box
  const row = (iconName, title, sub, href, onclick, extra = '') => el('button', { type: 'button', class: `link-row${extra}${href && href === current ? ' is-on' : ''}`, onclick: onclick || (() => pick(href)) },
    ico(iconName), el('span', { class: 'link-row__txt' }, el('strong', {}, title), sub ? el('small', {}, sub) : null));
  const groups = [];
  const group = (title, ...children) => { const g = el('div', { class: 'link-group' }, el('p', { class: 'link-group__title' }, title), ...children); groups.push(g); return g; };

  const pages = state.doc.pages.map((p, i) => {
    const href = pageHref(p, i);
    const pageRow = row('layout', p.title || 'Untitled page', `${href}${p.draft && i > 0 ? ' · unpublished' : ''}`, href);
    const secRows = p.sections.filter((sec) => BLOCKS[sec.type]).map((sec) => {
      const block = BLOCKS[sec.type];
      const name = sec.label || sectionSummary(sec) || block.label;
      const id = anchorId(sec.data?.anchor);
      const hrefFor = (a) => (i === from ? `#${a}` : `${href}#${a}`);
      const node = row(block.icon || 'layout', name, `${block.label}${id ? ` · #${id}` : ''}`, id ? hrefFor(id) : '', () => {
        let a = anchorId(sec.data.anchor);
        if (!a) {
          a = uniqueAnchor(p, sec);
          sec.data.anchor = a;
          if (i === state.page) refreshSection(sec.id);
          toast(`“${name}” can now be linked to as #${a}`);
        }
        pick(hrefFor(a));
      }, ' link-row--sub');
      items.push({ node, text: `${name} ${block.label} ${id}`.toLowerCase(), page: i });
      return node;
    });
    const open = i === (from === -1 ? state.page : from);
    const toggle = secRows.length ? el('button', { type: 'button', class: 'link-more', 'aria-expanded': String(open) }, `${secRows.length} section${secRows.length === 1 ? '' : 's'}`, ico('chevron-down')) : null;
    const box = el('div', { class: `link-page${open ? ' is-open' : ''}` }, el('div', { class: 'link-page__head' }, pageRow, toggle), ...secRows);
    toggle?.addEventListener('click', () => { box.classList.toggle('is-open'); toggle.setAttribute('aria-expanded', String(box.classList.contains('is-open'))); });
    items.push({ node: pageRow, text: `${p.title} ${href}`.toLowerCase(), page: i, head: true });
    return box;
  });
  group('Pages', ...pages);

  const posts = state.doc.posts || [];
  if (posts.length) {
    const live = new Set(theme.publishedPosts ? theme.publishedPosts(state.doc) : posts);
    group('Blog posts', ...posts.map((post) => {
      const href = `/${POSTS_BASE}/${post.slug}/`;
      const node = row('pen', postTitle(post), `${href}${live.has(post) ? '' : ' · not live yet'}`, href);
      items.push({ node, text: `${postTitle(post)} ${href}`.toLowerCase() });
      return node;
    }));
  }

  const s = state.doc.site;
  const contact = [];
  if (s.email) contact.push(row('mail', `Email ${s.email}`, 'Opens the visitor’s email app', `mailto:${s.email}`));
  if (s.phone) contact.push(row('phone', `Call ${s.phone}`, 'Dials on phones', `tel:${s.phone.replace(/[^+\d]/g, '')}`));
  contact.forEach((node) => items.push({ node, text: node.textContent.toLowerCase() }));
  group('Email & phone', ...(contact.length ? contact : [el('p', { class: 'p-hint' }, 'Add your email and phone under Settings → Business to link to them.')]));

  const list = el('div', { class: 'link-list' }, ...groups);
  const none = el('p', { class: 'p-hint', hidden: true }, 'Nothing matches. Type a web address below instead.');
  const search = el('input', { class: 'in', type: 'search', placeholder: 'Search pages, sections and posts…', 'aria-label': 'Search' });
  const isWeb = current && !/^(\/|#|mailto:|tel:)/i.test(current);
  const url = el('input', { class: 'in', type: 'text', placeholder: 'https://example.com', value: isWeb ? current : '', spellcheck: false, 'aria-label': 'Web address' });
  const useUrl = () => {
    const href = normalizeLink(url.value);
    if (!href) { toast('That doesn’t look like a web address. Try https://example.com', { error: true }); url.focus(); return; }
    pick(href);
  };
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useUrl(); } });

  const filter = () => {
    const q = search.value.trim().toLowerCase();
    list.classList.toggle('is-searching', !!q);
    const shownPages = new Set();
    for (const it of items) {
      const hit = !q || it.text.includes(q);
      it.node.hidden = !hit;
      if (hit && q && it.page != null) shownPages.add(it.page);
    }
    // A page stays visible while any of its sections match.
    pages.forEach((box, i) => { box.hidden = !!q && !shownPages.has(i); box.querySelector('.link-page__head > .link-row').hidden = false; });
    groups.forEach((g) => { g.hidden = !!q && !g.querySelector('.link-row:not([hidden])'); });
    none.hidden = !q || groups.some((g) => !g.hidden);
  };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = [...list.querySelectorAll('.link-row')].find((b) => b.offsetParent);
    if (first) first.click(); else if (normalizeLink(search.value)) { url.value = search.value; useUrl(); }
  });

  openModal('Choose a link', el('div', { class: 'link-pick' },
    search, list, none,
    el('div', { class: 'f link-pick__web' }, el('label', {}, 'Or link to another website'), el('div', { class: 'link-pick__url' }, url, el('button', { type: 'button', class: 'ed-btn', onclick: useUrl }, 'Use link')))));
  setTimeout(() => search.focus(), 50);
}

const chooseLinkBtn = (onclick) => el('button', { type: 'button', class: 'ed-btn ed-btn--sm link-choose', title: 'Choose a page, section, post, email or phone', onclick }, ico('link'), 'Choose');

function fieldControl(f, path, val, change, target, onRender) {
  const wrap = el('div', { class: 'f' });
  const label = f.label ? el('label', {}, f.label) : null;
  const help = f.help ? el('p', { class: 'f__help' }, f.help) : null;
  switch (f.type) {
    case 'note':
      return el('p', { class: 'note' }, f.text);
    case 'text':
    case 'link': {
      const input = el('input', { class: 'in', type: 'text', value: val ?? '', 'data-path': path, placeholder: f.placeholder || null, list: f.type === 'link' ? linkSuggestions() : null,
        oninput: (e) => change(path, e.target.value, { soon: true }) });
      const choose = f.type === 'link' ? chooseLinkBtn(() => openLinkPicker((href) => change(path, href, { structural: true }), { from: pageOfTarget(target), current: input.value.trim() })) : null;
      put(wrap, label, choose ? el('div', { class: 'f-link' }, input, choose) : input, help);
      return wrap;
    }
    case 'date': {
      const input = el('input', { class: 'in', type: 'date', value: val || '', 'data-path': path, onchange: (e) => change(path, e.target.value) });
      put(wrap, label, input, help);
      return wrap;
    }
    case 'markdown': {
      const ta = el('textarea', { class: 'md-in', rows: f.rows || 14, 'data-path': path, placeholder: f.placeholder || 'Start writing…', oninput: (e) => change(path, e.target.value, { soon: true }) });
      ta.value = val ?? '';
      const fire = () => { ta.focus(); ta.dispatchEvent(new Event('input')); };
      // Formatted text from Word, Google Docs or web pages keeps its headings, lists, bold and links.
      ta.addEventListener('paste', (e) => {
        const html = e.clipboardData?.getData('text/html');
        if (!html || !hasFormatting(html)) return;
        const md = htmlToMarkdown(html);
        if (!md) return;
        e.preventDefault();
        const [a, b] = [ta.selectionStart, ta.selectionEnd];
        const before = ta.value.slice(0, a);
        const gap = before && !before.endsWith('\n\n') && /\n/.test(md) ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
        ta.setRangeText(gap + md, a, b, 'end');
        fire();
        toast('Pasted with formatting. Press Ctrl+Z to undo.');
      });
      const block = (text) => {
        const [a, b] = [ta.selectionStart, ta.selectionEnd];
        const before = ta.value.slice(0, a);
        const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        ta.setRangeText(`${lead}${text(ta.value.slice(a, b))}\n`, a, b, 'end');
        fire();
      };
      const callout = (kind, ph) => block((sel) => `> [!${kind}]\n${(sel || ph).split('\n').map((l) => `> ${l}`).join('\n')}`);
      const wrapSel = (before, after, ph) => {
        const [a, b] = [ta.selectionStart, ta.selectionEnd];
        const sel = ta.value.slice(a, b) || ph;
        ta.setRangeText(before + sel + after, a, b, 'end');
        if (a === b) ta.setSelectionRange(a + before.length, a + before.length + sel.length);
        fire();
      };
      const prefix = (pre) => {
        const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
        ta.setRangeText(pre, start, start, 'end');
        fire();
      };
      const tools = [
        [el('b', {}, 'B'), 'Bold', () => wrapSel('**', '**', 'bold text')],
        [el('i', {}, 'I'), 'Italic', () => wrapSel('*', '*', 'italic text')],
        [ico('link'), 'Link', () => openLinkPicker((url) => wrapSel('[', `](${url.replace(/\s/g, '%20').replace(/\)/g, '%29')})`, 'link text'), { from: pageOfTarget(target) })],
        [el('b', {}, 'H'), 'Heading', () => prefix('## ')],
        [ico('list'), 'Bullet list', () => prefix('- ')],
        [ico('quote'), 'Quote', () => prefix('> ')],
        ...(has('code') ? [
          [ico('code'), 'Code (inline)', () => wrapSel('`', '`', 'code')],
          [el('b', { class: 'md-tools__txt' }, '{ }'), 'Code block', () => block((sel) => `\`\`\`\n${sel || 'paste code here'}\n\`\`\``)],
        ] : []),
        ...(has('callouts') ? [
          [ico('bulb'), 'Tip box', () => callout('TIP', 'A helpful tip.')],
          [ico('alert'), 'Warning box', () => callout('WARNING', 'Something to watch out for.')],
        ] : []),
        [ico('image'), 'Image', () => openMediaPicker((src) => { const nl = ta.value.indexOf('\n', ta.selectionEnd); const at = nl === -1 ? ta.value.length : nl; ta.setRangeText(`\n![](${mediaRef(src)})\n`, at, at, 'end'); fire(); })],
      ];
      put(wrap, label, el('div', { class: 'md-tools' }, tools.map(([content, title, fn]) => el('button', { type: 'button', title, onclick: fn }, content))), ta, help);
      return wrap;
    }
    case 'textarea': {
      const ta = el('textarea', { rows: 3, 'data-path': path, placeholder: f.placeholder || null, oninput: (e) => change(path, e.target.value, { soon: true }) });
      ta.value = val ?? '';
      put(wrap, label, ta, help || el('p', { class: 'f__help' }, 'Tip: **bold**, *italic*, [link text](https://…)'));
      return wrap;
    }
    case 'select': {
      const s = el('select', { onchange: (e) => change(path, e.target.value, { structural: true }) },
        f.options.map(([v, l]) => el('option', { value: v, selected: String(val) === v }, l)));
      put(wrap, label, s, help);
      return wrap;
    }
    case 'segmented': {
      const seg = el('div', { class: 'ed-seg ed-seg--full' }, f.options.map(([v, l]) =>
        el('button', { type: 'button', class: String(val ?? f.default) === v ? 'is-on' : '', onclick: () => change(path, v, { structural: true }) }, l)));
      put(wrap, el('span', { class: 'f__label' }, f.label), seg, help);
      return wrap;
    }
    case 'swatches': {
      const colors = { light: 'var(--sw-bg)', alt: 'var(--sw-surface)', dark: 'var(--sw-dark)', brand: 'var(--sw-primary)' };
      const t = { ...THEME_PRESETS.midnight, ...state.doc.theme };
      const real = { light: t.bg, alt: t.surface, dark: t.dark, brand: t.primary };
      const row = el('div', { class: 'sw-row' }, f.options.map(([v, l]) =>
        el('button', { type: 'button', class: `sw${val === v ? ' is-on' : ''}`, title: l, onclick: () => change(path, v, { structural: true }) },
          el('i', { style: `background:${real[v] || colors[v]}` }), l)));
      put(wrap, el('span', { class: 'f__label' }, f.label), row);
      return wrap;
    }
    case 'toggle': {
      const lab = el('label', { class: 'switch' }, f.label, el('input', { type: 'checkbox', 'data-path': path, checked: !!(val ?? f.default), onchange: (e) => change(path, e.target.checked, { structural: true }) }));
      put(wrap, lab, help);
      return wrap;
    }
    case 'color': {
      const hex = el('input', { class: 'in', type: 'text', value: val || '', maxlength: 7 });
      const pick = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(val) ? val : '#000000' });
      pick.addEventListener('input', () => { hex.value = pick.value; change(path, pick.value, { soon: true }); });
      hex.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { pick.value = hex.value; change(path, hex.value); } else hex.value = getPath(target, path); });
      put(wrap, label, el('div', { class: 'color' }, pick, hex));
      return wrap;
    }
    case 'button': {
      const b = val || {};
      const lbl = el('input', { class: 'in', type: 'text', placeholder: 'Button text (empty = hidden)', value: b.label || '', 'data-path': `${path}.label`,
        oninput: (e) => change(`${path}.label`, e.target.value, { soon: true }) });
      const url = el('input', { class: 'in', type: 'text', placeholder: 'Link: /contact/, #section, https://…', value: b.href || '', list: linkSuggestions(), 'data-path': `${path}.href`,
        oninput: (e) => change(`${path}.href`, e.target.value, { soon: true }) });
      const choose = chooseLinkBtn(() => openLinkPicker((href) => change(`${path}.href`, href, { structural: true }), { from: pageOfTarget(target), current: url.value.trim() }));
      put(wrap, el('span', { class: 'f__label' }, f.label), el('div', { class: 'f-btn' }, lbl, el('div', { class: 'f-btn__url' }, ico('link'), url, choose)), help);
      return wrap;
    }
    case 'icon': {
      const det = el('details', { class: 'icon-pick' },
        el('summary', {}, ico(val || 'sparkle'), (val || 'Choose icon').replace(/-/g, ' '), el('span', { class: 'chev' }, ico('chevron-down'))),
        el('div', { class: 'icon-grid' }, ICON_NAMES.map((n) =>
          el('button', { type: 'button', title: n, class: n === val ? 'is-on' : '', onclick: () => change(path, n, { structural: true }) }, ico(n)))));
      put(wrap, el('span', { class: 'f__label' }, f.label), det);
      return wrap;
    }
    case 'image': {
      const preview = el('div', { class: `img-field__preview${val ? ' has-img' : ''}`, style: val ? `background-image:url("${String(siteAsset(val)).replace(/["\\]/g, encodeURIComponent)}")` : '' }, val ? '' : 'No image');
      const file = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
        const f0 = e.target.files[0];
        if (!f0) return;
        try { const src = await imageToDataURL(f0); addToMedia(src, f0.name); change(path, src, { structural: true }); } catch (err) { toast(err.message, { error: true }); }
      } });
      const url = el('input', { class: 'in', type: 'text', placeholder: 'or paste an image URL', 'data-path': path, value: String(val || '').startsWith('data:') ? '' : (val || ''),
        onchange: (e) => change(path, e.target.value.trim(), { structural: true }) });
      put(wrap, el('span', { class: 'f__label' }, f.label), el('div', { class: 'img-field' }, preview,
        el('div', { class: 'img-field__btns' },
          el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: () => file.click() }, ico('upload'), val ? 'Replace' : 'Upload'),
          el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: () => openMediaPicker((src) => change(path, src, { structural: true })) }, ico('image'), 'Library'),
          val ? el('button', { type: 'button', class: 'ed-btn ed-btn--sm ed-btn--danger', title: 'Remove image', onclick: () => change(path, '', { structural: true }) }, ico('trash')) : null),
        url, file), help);
      return wrap;
    }
    case 'list': {
      const items = Array.isArray(val) ? val : [];
      const list = el('div', { class: 'list-f' });
      items.forEach((item, i) => {
        const key = `${state.sel}:${path}.${i}`;
        const isOpen = state.open.has(key);
        const move = (dir) => {
          const j = i + dir;
          if (j < 0 || j >= items.length) return;
          [items[i], items[j]] = [items[j], items[i]];
          state.open.delete(key);
          change(path, items, { structural: true });
        };
        const head = el('div', { class: 'list-item__head', onclick: (e) => {
          if (e.target.closest('button')) return;
          if (isOpen) state.open.delete(key); else state.open.add(key);
          renderInspector();
        } },
        el('span', { class: 'chev' }, ico('chevron-right')),
        el('span', { class: 't' }, String(item[f.itemLabel] || `Item ${i + 1}`)),
        el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }, ico('chevron-up')),
        el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm', title: 'Move down', disabled: i === items.length - 1, onclick: () => move(1) }, ico('chevron-down')),
        el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm ed-icon-btn--danger', title: 'Remove', onclick: () => { items.splice(i, 1); state.open.clear(); change(path, items, { structural: true }); } }, ico('trash')));
        const node = el('div', { class: `list-item${isOpen ? ' is-open' : ''}` }, head);
        if (isOpen) {
          const body = el('div', { class: 'list-item__body' });
          renderFields(body, f.itemFields, target, onRender, `${path}.${i}.`);
          node.append(body);
        }
        list.append(node);
      });
      list.append(el('button', { type: 'button', class: 'list-add', onclick: () => {
        items.push(f.item());
        state.open.add(`${state.sel}:${path}.${items.length - 1}`);
        change(path, items, { structural: true });
      } }, ico('plus'), 'Add item'));
      put(wrap, el('span', { class: 'f__label' }, f.label, el('span', { class: 'badge' }, String(items.length))), list);
      return wrap;
    }
    default:
      return wrap;
  }
}

// SVG files can carry scripts that would run on the site when the file is
// opened directly, so only the drawing is kept. It is parsed inside a
// <template>, whose contents are inert (nothing loads, no handler runs).
function cleanSVG(text) {
  const tpl = document.createElement('template');
  tpl.innerHTML = stripHandlers(text);
  const svg = tpl.content.querySelector('svg');
  if (!svg) throw new Error('That SVG file could not be read.');
  svg.querySelectorAll('script, foreignObject, iframe, embed, object, audio, video, set, animate[attributeName*="href" i]').forEach((n) => n.remove());
  for (const n of [svg, ...svg.querySelectorAll('*')]) {
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      const v = a.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name.endsWith(':href')) && !v.startsWith('#') && !v.startsWith('data:image/'))) n.removeAttribute(a.name);
    }
  }
  const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

// Resize uploads so drafts stay small; SVGs are cleaned but keep their size.
async function imageToDataURL(file) {
  const read = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  if (file.type === 'image/svg+xml') {
    if (file.size > 400_000) throw new Error('That SVG is too large (max 400 KB).');
    return cleanSVG(await file.text());
  }
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  let url = c.toDataURL('image/webp', 0.85);
  if (!url.startsWith('data:image/webp')) url = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
  return url;
}

// ---------------------------------------------------------------------------
// Left panel
const THUMBS = {
  hero: '<div class="thumb thumb--dark"><div class="t-row"><div style="display:grid;gap:4px"><i style="width:40%" class="t-acc"></i><i></i><i style="width:70%"></i><div class="t-row" style="width:60%"><i class="t-acc" style="height:8px"></i><i style="height:8px"></i></div></div><div class="t-box" style="height:36px"></div></div></div>',
  logos: '<div class="thumb"><div class="t-row"><i></i><i></i><i></i><i></i></div></div>',
  services: '<div class="thumb"><i style="width:40%;margin:0 auto" class="t-dark"></i><div class="t-row"><div class="t-box"></div><div class="t-box"></div><div class="t-box"></div></div></div>',
  split: '<div class="thumb"><div class="t-row"><div class="t-img"></div><div style="display:grid;gap:4px;align-content:center"><i class="t-dark"></i><i></i><i style="width:60%"></i></div></div></div>',
  stats: '<div class="thumb thumb--dark"><div class="t-row"><i class="t-acc" style="height:10px"></i><i class="t-acc" style="height:10px"></i><i class="t-acc" style="height:10px"></i></div><div class="t-row"><i></i><i></i><i></i></div></div>',
  checklist: '<div class="thumb"><div class="t-row"><i class="t-acc"></i><i class="t-acc"></i></div><div class="t-row"><i></i><i></i></div><div class="t-row"><i></i><i></i></div></div>',
  steps: '<div class="thumb"><div class="t-row"><div class="t-box"></div><div class="t-box"></div><div class="t-box"></div><div class="t-box"></div></div></div>',
  testimonials: '<div class="thumb"><div class="t-row"><div class="t-box" style="height:34px"></div><div class="t-box" style="height:34px"></div></div></div>',
  pricing: '<div class="thumb"><div class="t-row"><div class="t-box" style="height:40px"></div><div class="t-box" style="height:40px;border-color:#3b82f6"></div><div class="t-box" style="height:40px"></div></div></div>',
  faq: '<div class="thumb"><div class="t-box" style="height:9px"></div><div class="t-box" style="height:9px"></div><div class="t-box" style="height:9px"></div></div>',
  cta: '<div class="thumb thumb--brand"><div class="t-row" style="align-items:center"><div style="display:grid;gap:4px"><i></i><i style="width:60%"></i></div><i style="height:12px;background:#fff;flex:.5"></i></div></div>',
  contact: '<div class="thumb"><div class="t-row"><div style="display:grid;gap:4px;align-content:center"><i class="t-dark"></i><i></i><i></i></div><div class="t-box" style="height:44px"></div></div></div>',
  text: '<div class="thumb"><i class="t-dark" style="width:50%"></i><i></i><i></i><i style="width:70%"></i></div>',
  blogfeed: '<div class="thumb"><div class="t-row"><div style="display:grid;gap:3px"><div class="t-img" style="height:18px"></div><i></i><i style="width:60%"></i></div><div style="display:grid;gap:3px"><div class="t-img" style="height:18px"></div><i></i><i style="width:60%"></i></div><div style="display:grid;gap:3px"><div class="t-img" style="height:18px"></div><i></i><i style="width:60%"></i></div></div></div>',
  gallery: '<div class="thumb"><div class="t-row"><div class="t-img" style="height:20px"></div><div class="t-img" style="height:20px"></div><div class="t-img" style="height:20px"></div></div><div class="t-row"><div class="t-img" style="height:20px"></div><div class="t-img" style="height:20px"></div><div class="t-img" style="height:20px"></div></div></div>',
  video: '<div class="thumb thumb--dark" style="place-items:center;display:grid"><span style="width:22px;height:22px;border-radius:50%;background:#3b82f6;display:block"></span></div>',
  map: '<div class="thumb" style="background:radial-gradient(circle at 1px 1px,#93c5fd 1.2px,transparent 0) 0 0/8px 8px,#eff6ff;display:grid;place-items:center"><span style="width:12px;height:12px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#2563eb;display:block"></span></div>',
  team: '<div class="thumb"><div class="t-row" style="justify-items:center"><div style="display:grid;gap:3px;justify-items:center"><span style="width:18px;height:18px;border-radius:50%;background:#93c5fd;display:block"></span><i style="width:24px"></i></div><div style="display:grid;gap:3px;justify-items:center"><span style="width:18px;height:18px;border-radius:50%;background:#93c5fd;display:block"></span><i style="width:24px"></i></div><div style="display:grid;gap:3px;justify-items:center"><span style="width:18px;height:18px;border-radius:50%;background:#93c5fd;display:block"></span><i style="width:24px"></i></div></div></div>',
  image: '<div class="thumb"><div class="t-img"></div></div>',
  resources: '<div class="thumb"><i class="t-dark" style="width:40%;margin:0 auto"></i><div class="t-row"><div class="t-box" style="height:26px;display:grid;grid-template-columns:8px 1fr;gap:3px;padding:3px;align-content:center"><i class="t-acc" style="height:8px"></i><i></i></div><div class="t-box" style="height:26px;display:grid;grid-template-columns:8px 1fr;gap:3px;padding:3px;align-content:center"><i class="t-acc" style="height:8px"></i><i></i></div><div class="t-box" style="height:26px;display:grid;grid-template-columns:8px 1fr;gap:3px;padding:3px;align-content:center"><i class="t-acc" style="height:8px"></i><i></i></div></div></div>',
  quote: '<div class="thumb"><i class="t-dark" style="width:40%;margin:0 auto"></i><div class="t-box" style="height:40px;display:grid;gap:3px;padding:4px;align-content:center"><div class="t-row"><i></i><i></i></div><div class="t-row"><i class="t-acc" style="flex:.4"></i><i style="flex:.4"></i><i style="flex:.4"></i></div><i class="t-acc" style="height:6px"></i></div></div>',
  booking: '<div class="thumb"><i class="t-dark" style="width:40%;margin:0 auto"></i><div class="t-box" style="height:38px;display:grid;grid-template-columns:repeat(5,1fr);gap:3px;padding:4px;align-content:center"><i></i><i class="t-acc"></i><i></i><i></i><i class="t-acc"></i><i></i><i></i><i class="t-acc"></i><i></i><i></i></div></div>',
};

function setTab(tab) {
  if (tab !== 'blog' && state.post) { flushCommit(); state.post = null; renderCanvas({ keepScroll: false }); renderInspector(); }
  state.tab = tab;
  $$('.ed-rail button').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === tab));
  renderPanel();
  syncUrl();
}

// The address bar remembers the page, post and panel (#page=services&tab=pages),
// so reloading or bookmarking the editor comes back to the same place.
const TABS = ['add', 'layers', 'pages', 'blog', 'media', 'theme', 'site', 'history', 'checkup', 'help'];
function syncUrl() {
  if (!state.doc) return;
  const q = new URLSearchParams();
  if (state.post) q.set('post', state.post);
  else if (state.page > 0) q.set('page', page().slug || String(state.page));
  if (state.tab !== 'add' && !(state.post && state.tab === 'blog')) q.set('tab', state.tab);
  const hash = q.toString();
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}
function restoreUrl() {
  const q = new URLSearchParams(location.hash.slice(1));
  const slug = q.get('page');
  const i = slug ? state.doc.pages.findIndex((p, n) => n > 0 && (p.slug === slug || String(n) === slug)) : -1;
  if (i > 0) state.page = i;
  const tab = q.get('tab');
  if (TABS.includes(tab) && (tab !== 'checkup' || has('audit'))) state.tab = tab;
  const post = q.get('post');
  if (post && findPost(post)) { state.post = post; state.tab = 'blog'; }
  $$('.ed-rail button').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === state.tab));
}

function renderPanel() {
  const box = $('#panel');
  const scroll = box.scrollTop;
  box.replaceChildren();
  ({ add: panelAdd, layers: panelLayers, pages: panelPages, media: panelMedia, blog: panelBlog, theme: panelTheme, site: panelSite, history: panelHistory, checkup: panelCheckup, help: panelHelp })[state.tab](box);
  box.scrollTop = scroll;
}

function panelHead(title, iconName, ...extra) { return el('div', { class: 'p-head' }, el('h2', {}, ico(iconName), title), ...extra); }

function panelAdd(box) {
  box.append(panelHead('Add a section', 'plus'));
  const body = el('div', { class: 'p-body' });
  const after = state.sel && !isChrome(state.sel) ? findSection(state.sel) : null;
  body.append(el('div', { class: 'p-callout' }, ico('arrow-right'),
    after ? `Adds after “${BLOCKS[after.type].label}”` : 'Adds to the end of the page',
    after ? el('button', { type: 'button', onclick: () => select(null) }, 'Add at end') : null));
  const clip = getClipboard();
  if (clip) {
    body.append(el('button', { type: 'button', class: 'ed-btn ed-btn--block', style: 'margin-bottom:8px', onclick: pasteSection },
      ico('clipboard2'), `Paste copied ${BLOCKS[clip.type]?.label || 'section'}`));
  }
  if (state.doc.saved?.length) {
    body.append(el('p', { class: 'p-sub' }, 'My saved sections'), el('div', { class: 'saved-list' }, state.doc.saved.map((sv) =>
      el('div', { class: 'saved-item' },
        el('button', { type: 'button', class: 'saved-item__main', title: 'Add this section', onclick: () => insertSection(sv.section) },
          el('span', { class: 'layer__icon' }, ico(BLOCKS[sv.section.type]?.icon || 'layout')),
          el('span', { class: 'layer__txt' }, el('strong', {}, sv.name), el('small', {}, BLOCKS[sv.section.type]?.label || ''))),
        el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm ed-icon-btn--danger', title: 'Remove from saved', onclick: () => {
          state.doc.saved = state.doc.saved.filter((x) => x.id !== sv.id); commit(); renderPanel();
        } }, ico('trash'))))));
  }
  body.append(...blockCards((type) => addSection(type)));
  box.append(body);
}

// Section cards grouped like the Add panel; onPick(type).
function blockCards(onPick) {
  const out = [];
  for (const g of BLOCK_GROUPS) {
    const entries = Object.entries(BLOCKS).filter(([, b]) => b.group === g);
    if (!entries.length) continue;
    out.push(el('p', { class: 'p-sub' }, g), el('div', { class: 'blocks' }, entries.map(([type, b]) =>
      el('button', { type: 'button', class: 'block-card', title: b.description, onclick: () => onPick(type) },
        el('div', { html: THUMBS[type] || '<div class="thumb"></div>' }),
        el('strong', {}, b.label, el('small', {}, b.description))))));
  }
  return out;
}

// The window behind the “+” buttons: adds a section at position `at`.
function openQuickAdd(at) {
  const list = sections();
  const name = (sec) => sec.label || sectionSummary(sec) || BLOCKS[sec.type]?.label || 'section';
  const where = !list.length ? 'Your page is empty. Pick a section to start with.'
    : at === 0 ? `Adds at the top of the page, above “${name(list[0])}”.`
      : at >= list.length ? `Adds at the end of the page, below “${name(list[list.length - 1])}”.`
        : `Adds between “${name(list[at - 1])}” and “${name(list[at])}”.`;
  const done = (fn) => () => { closeModal(); fn(); };
  const body = el('div', { class: 'quick-add' }, el('p', {}, where));
  const clip = getClipboard();
  if (clip && BLOCKS[clip.type]) {
    body.append(el('button', { type: 'button', class: 'ed-btn ed-btn--block', style: 'margin-bottom:8px', onclick: done(() => insertSection(clip, `${BLOCKS[clip.type].label} pasted`, at)) },
      ico('clipboard2'), `Paste copied ${BLOCKS[clip.type].label}`));
  }
  const saved = (state.doc.saved || []).filter((sv) => BLOCKS[sv.section?.type]);
  if (saved.length) {
    body.append(el('p', { class: 'p-sub' }, 'My saved sections'), el('div', { class: 'saved-list' }, saved.map((sv) => el('div', { class: 'saved-item' },
      el('button', { type: 'button', class: 'saved-item__main', onclick: done(() => insertSection(sv.section, `${sv.name} added`, at)) },
        el('span', { class: 'layer__icon' }, ico(BLOCKS[sv.section.type].icon || 'layout')),
        el('span', { class: 'layer__txt' }, el('strong', {}, sv.name), el('small', {}, BLOCKS[sv.section.type].label)))))));
  }
  body.append(...blockCards((type) => { closeModal(); addSection(type, at); }));
  openModal('Add a section', body);
}

function panelLayers(box) {
  box.append(panelHead(`Layers · ${page().title}`, 'layers'));
  const body = el('div', { class: 'p-body' }, el('p', { class: 'p-hint' }, 'Drag to reorder. Click to select.'));
  const list = el('ul', { class: 'layers' });
  const fixed = (id, label) => el('li', { class: `layer is-fixed${state.sel === id ? ' is-sel' : ''}`, onclick: () => select(id, { scroll: true }) },
    el('span', { class: 'layer__icon' }, ico('layout')), el('span', { class: 'layer__txt' }, el('strong', {}, label), el('small', {}, 'Shared on all pages')));
  list.append(fixed('__header', 'Header'));
  let dragId = null;
  sections().forEach((sec) => {
    const b = BLOCKS[sec.type];
    const li = el('li', { class: `layer${state.sel === sec.id ? ' is-sel' : ''}${sec.hidden ? ' is-hidden' : ''}`, draggable: 'true',
      onclick: (e) => { if (!e.target.closest('button')) select(sec.id, { scroll: true }); },
      ondragstart: (e) => { dragId = sec.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', sec.id); },
      ondragover: (e) => {
        if (!dragId || dragId === sec.id) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        li.classList.toggle('drop-before', before);
        li.classList.toggle('drop-after', !before);
      },
      ondragleave: () => li.classList.remove('drop-before', 'drop-after'),
      ondrop: (e) => {
        e.preventDefault();
        const before = li.classList.contains('drop-before');
        li.classList.remove('drop-before', 'drop-after');
        const arr = sections();
        const from = arr.findIndex((s) => s.id === dragId);
        const [moved] = arr.splice(from, 1);
        let to = arr.findIndex((s) => s.id === sec.id);
        if (!before) to += 1;
        arr.splice(to, 0, moved);
        dragId = null;
        commit(); renderCanvas(); renderPanel();
      },
    },
    el('span', { class: 'layer__grip' }, ico('grip')),
    el('span', { class: 'layer__icon' }, ico(b.icon)),
    el('span', { class: 'layer__txt' }, el('strong', {}, sec.label || b.label), el('small', {}, sec.label ? b.label : sectionSummary(sec))),
    el('span', { class: 'layer__actions' },
      el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm', title: sec.hidden ? 'Show' : 'Hide', onclick: () => runTool('hide', sec.id) }, ico(sec.hidden ? 'eye' : 'eye-off')),
      el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm ed-icon-btn--danger', title: 'Delete', onclick: () => runTool('delete', sec.id) }, ico('trash'))));
    list.append(li);
    // The section's elements, indented under it.
    elementsOf(sec).forEach((item, n) => {
      const def = ELEMENTS[item?.type];
      if (!def) return;
      list.append(el('li', { class: `layer layer--el${state.sel === sec.id && state.el === n ? ' is-sel' : ''}`, onclick: () => selectElement(sec.id, n, { scroll: true }) },
        el('span', { class: 'layer__icon' }, ico(def.icon)), el('span', { class: 'layer__txt' }, el('strong', {}, elementSummary(item)), el('small', {}, def.label))));
    });
  });
  list.append(fixed('__footer', 'Footer'));
  body.append(list);
  if (!sections().length) body.append(el('p', { class: 'p-hint', style: 'margin-top:12px' }, 'This page is empty — add a section from the Add tab.'));
  box.append(body);
}

function slugify(s) { return String(s).toLowerCase().trim().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function goToPage(i) {
  flushCommit();
  state.post = null;
  state.page = i;
  state.sel = null;
  renderCanvas({ keepScroll: false });
  renderInspector();
  renderPanel();
  updateTopbar();
  syncUrl();
}

function panelPages(box) {
  box.append(panelHead('Pages', 'file', el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: openAddPage }, ico('plus'), 'New')));
  const body = el('div', { class: 'p-body' }, el('p', { class: 'p-hint' }, 'The first page is your home page. Pages shown in navigation appear in the header and footer.'));
  const list = el('div', { class: 'pages' });
  state.doc.pages.forEach((p, i) => {
    const cur = i === state.page;
    const item = el('div', { class: `page-item${cur ? ' is-current' : ''}` },
      el('div', { class: 'page-item__row', onclick: (e) => { if (!e.target.closest('button') && !cur) goToPage(i); } },
        ico(i === 0 ? 'home' : 'file'), el('strong', {}, p.title), el('small', {}, i === 0 ? '/' : `/${p.slug}`),
        i > 0 && p.draft ? el('span', { class: 'badge' }, 'Unpublished') : p.showInNav === false ? el('span', { class: 'badge' }, 'Not in menu') : null));
    if (cur) {
      const b = el('div', { class: 'page-item__body' });
      const upd = (rerender = true) => { commitSoon(); if (rerender) renderCanvas(); updateTopbar(); };
      const preview = el('div', { class: 'seo-preview' });
      const paintPreview = () => preview.replaceChildren(...previewCards(p, i));
      paintPreview();
      const shareBox = el('div');
      if (has('page-share-image')) {
        renderFields(shareBox, [{ key: 'shareImage', label: 'Share image for this page', type: 'image', help: 'Shown when this page is shared on social media or in messages. Leave empty to use the site’s share image. 1200×630 works best.' }], p, () => {}, '', renderPanel);
      }
      b.append(
        el('div', { class: 'f', style: 'margin-top:10px' }, el('label', {}, 'Page name'), el('input', { class: 'in', value: p.title, oninput: (e) => {
          // Once a page is live, renaming it no longer changes its address.
          const auto = p.slug === slugify(p.title) && !publishedPath('page', p.id);
          p.title = e.target.value;
          if (i > 0 && auto) { p.slug = slugify(p.title); const sl = $('.page-slug', b); if (sl) sl.value = p.slug; }
          upd();
        } })),
        i > 0 ? el('div', { class: 'f' }, el('label', {}, 'Web address (yoursite.com/…/)'), el('input', { class: 'in page-slug', value: p.slug, oninput: (e) => { p.slug = slugify(e.target.value) || `page-${i}`; upd(); },
          onchange: (e) => { e.target.value = p.slug; keepOldAddress('page', p.id, pageHref(p, i)); commit(); renderPanel(); } }),
        has('redirects') && publishedPath('page', p.id) ? el('p', { class: 'f__help' }, 'This page is live. If you change its address, visitors using the old one are sent here automatically.') : null) : null,
        i > 0 && has('page-drafts') ? el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Show on website', el('input', { type: 'checkbox', checked: !p.draft, onchange: (e) => {
          if (e.target.checked) delete p.draft; else p.draft = true;
          commit(); renderCanvas(); renderPanel(); updateTopbar();
          toast(p.draft ? `“${p.title}” will be taken off your site when you publish` : `“${p.title}” will go live when you publish`);
        } })), el('p', { class: 'f__help' }, NOT_SECRET)) : null,
        el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Show in navigation', el('input', { type: 'checkbox', checked: p.showInNav !== false, onchange: (e) => { p.showInNav = e.target.checked; commit(); renderCanvas(); renderPanel(); } }))),
        el('p', { class: 'p-sub' }, 'Search engines'),
        has('noindex') ? el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Hide from search engines', el('input', { type: 'checkbox', checked: !!p.noindex, onchange: (e) => {
          if (e.target.checked) p.noindex = true; else delete p.noindex;
          commit(); renderPanel();
        } })), el('p', { class: 'f__help' }, i === 0 && p.noindex ? 'Your home page won’t appear in Google and other search engines.' : 'The page stays on your site, but Google and others are asked not to list it.')) : null,
        el('div', { class: 'f' }, el('label', {}, 'Page title'), el('input', { class: 'in', 'data-path': 'seoTitle', value: p.seoTitle || '', placeholder: `${p.title} | ${state.doc.site.name}`, oninput: (e) => { p.seoTitle = e.target.value; upd(false); paintPreview(); } })),
        el('div', { class: 'f' }, el('label', {}, 'Description'), Object.assign(el('textarea', { rows: 3, 'data-path': 'seoDescription', placeholder: 'One or two sentences that describe this page.', oninput: (e) => { p.seoDescription = e.target.value; upd(false); paintPreview(); } }), { value: p.seoDescription || '' })),
        shareBox,
        preview,
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { type: 'button', class: 'ed-btn ed-btn--sm', disabled: i <= 1, title: i === 0 ? 'Home stays first' : 'Move up', onclick: () => movePage(i, -1) }, ico('chevron-up')),
          el('button', { type: 'button', class: 'ed-btn ed-btn--sm', disabled: i === 0 || i === state.doc.pages.length - 1, title: 'Move down', onclick: () => movePage(i, 1) }, ico('chevron-down')),
          el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: () => duplicatePage(i) }, ico('copy'), 'Duplicate'),
          el('button', { type: 'button', class: 'ed-btn ed-btn--sm', title: 'Start new pages from this one', onclick: () => saveAsTemplate(i) }, ico('bookmark'), 'Save as template'),
          i > 0 ? el('button', { type: 'button', class: 'ed-btn ed-btn--sm ed-btn--danger', onclick: () => deletePage(i) }, ico('trash'), 'Delete') : null));
      item.append(b);
    }
    list.append(item);
  });
  body.append(list);
  box.append(body);
}

const NOT_SECRET = 'Hidden from visitors, but not secret: your site’s files are public on GitHub, so don’t put anything private here.';

// The address a page or post has on the live site right now ('' if it isn't live).
let publishedCache = { json: null, doc: null };
function publishedDoc() {
  if (publishedCache.json !== state.published) {
    let doc = null;
    try { doc = state.published ? JSON.parse(state.published) : null; } catch { doc = null; }
    publishedCache = { json: state.published, doc };
  }
  return publishedCache.doc;
}
function publishedPath(kind, id) {
  const pub = publishedDoc();
  if (!pub) return '';
  if (kind === 'page') {
    const i = pub.pages.findIndex((x) => x.id === id);
    return i > 0 && !pub.pages[i].draft && pub.pages[i].slug ? `/${pub.pages[i].slug}/` : '';
  }
  const post = (pub.posts || []).find((x) => x.id === id);
  return post && post.published !== false && post.slug ? `/${POSTS_BASE}/${post.slug}/` : '';
}

// After a live page or post gets a new address, send visitors (and old
// redirects) from the published address to the new one.
// Returns the old address when a new redirect was added.
function keepOldAddress(kind, id, newPath, { quiet = false } = {}) {
  if (!has('redirects')) return '';
  const old = publishedPath(kind, id);
  if (!old) return '';
  const list = (state.doc.redirects ||= []);
  for (const r of list) if (theme.redirectTo(r.to) === old) r.to = newPath;
  const from = theme.redirectFrom(old);
  const at = list.findIndex((r) => theme.redirectFrom(r.from) === from);
  if (old === newPath) { if (at >= 0) list.splice(at, 1); return ''; }
  if (at >= 0) { list[at].to = newPath; return ''; }
  list.push({ from: old, to: newPath });
  if (!quiet) toast(`Visitors to ${old} will be sent to ${newPath}. Manage this in Settings → Redirects.`);
  return old;
}

// Before publishing: every live page or post whose address changed keeps its old one working.
function keepAllOldAddresses() {
  const moved = [];
  state.doc.pages.forEach((p, i) => { if (i > 0) { const old = keepOldAddress('page', p.id, pageHref(p, i), { quiet: true }); if (old) moved.push([old, pageHref(p, i)]); } });
  (state.doc.posts || []).forEach((p) => { const to = `/${POSTS_BASE}/${p.slug}/`; const old = keepOldAddress('post', p.id, to, { quiet: true }); if (old) moved.push([old, to]); });
  return moved;
}

// What a page may look like in Google results and when its link is shared.
function previewCards(p, i) {
  const s = state.doc.site;
  let host = '';
  try { host = new URL(s.url || SITE).host; } catch { host = new URL(SITE).host; }
  const cut = (t, n) => { const v = String(t || '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
  const path = pageHref(p, i).replace(/^\/|\/$/g, '');
  const title = p.seoTitle || (i === 0 ? s.name : `${p.title} | ${s.name}`);
  const desc = p.seoDescription || s.description || '';
  const img = p.shareImage || s.shareImage;
  return [
    el('p', { class: 'p-sub' }, 'How it may look on Google'),
    el('div', { class: 'serp' }, el('small', {}, path ? `${host} › ${path.split('/').join(' › ')}` : host), el('strong', {}, cut(title, 60)),
      el('p', {}, cut(desc, 160) || 'Add a description so search engines show your own words here.')),
    el('p', { class: 'p-sub' }, 'When the link is shared'),
    el('div', { class: 'share-card' },
      img ? el('div', { class: 'share-card__img', style: `background-image:url("${String(siteAsset(img)).replace(/["\\]/g, encodeURIComponent)}")` })
        : el('div', { class: 'share-card__img is-empty' }, 'No share image yet'),
      el('div', { class: 'share-card__body' }, el('small', {}, host.toUpperCase()), el('strong', {}, cut(title, 70)), desc ? el('p', {}, cut(desc, 110)) : null)),
  ];
}

function uniqueSlug(base) {
  let s = base || 'page';
  let n = 2;
  while (state.doc.pages.some((p) => p.slug === s)) s = `${base}-${n++}`;
  return s;
}

function movePage(i, dir) {
  const j = i + dir;
  const ps = state.doc.pages;
  if (j < 1 || j >= ps.length || i < 1) return;
  [ps[i], ps[j]] = [ps[j], ps[i]];
  state.page = j;
  commit(); renderCanvas(); renderPanel(); updateTopbar();
}

function duplicatePage(i) {
  const copy = clone(state.doc.pages[i]);
  copy.id = uid('p');
  copy.title = `${copy.title} copy`;
  copy.slug = uniqueSlug(slugify(copy.title));
  copy.sections.forEach((s) => { s.id = uid(); });
  state.doc.pages.splice(i + 1, 0, copy);
  commit();
  goToPage(i + 1);
}

function deletePage(i) {
  const p = state.doc.pages[i];
  if (!confirm(`Delete the “${p.title}” page? You can undo this.`)) return;
  state.doc.pages.splice(i, 1);
  commit();
  goToPage(Math.max(0, i - 1));
  toast(`Page “${p.title}” deleted`, { action: 'Undo', onAction: undo });
}

// Starting points for new pages. Templates whose sections this site doesn't
// have (an older site theme) are left out.
const PAGE_TEMPLATES = {
  blank: { label: 'Blank', desc: 'Just a page header', sections: ['hero'] },
  custom: { label: 'Build your own', desc: 'Your own text, images and buttons', sections: ['hero', 'blank'] },
  services: { label: 'Services', desc: 'What you offer, questions, call to action', sections: ['hero', 'services', 'faq', 'cta'] },
  about: { label: 'About', desc: 'Your story, skills and numbers', sections: ['hero', 'split', 'checklist', 'stats'] },
  landing: { label: 'Landing', desc: 'A full marketing page', sections: ['hero', 'logos', 'services', 'stats', 'steps', 'testimonials', 'cta'] },
  pricing: { label: 'Pricing', desc: 'Plans and common questions', sections: ['hero', 'pricing', 'faq', 'cta'] },
  booking: { label: 'Book a call', desc: 'Booking calendar and questions', sections: ['hero', 'booking', 'faq'] },
  contact: { label: 'Contact', desc: 'Contact details, form and map', sections: ['contact', 'map'] },
  portfolio: { label: 'Our work', desc: 'Photos and reviews', sections: ['hero', 'gallery', 'testimonials', 'cta'] },
  team: { label: 'Team', desc: 'The people behind the business', sections: ['hero', 'team', 'cta'] },
  faq: { label: 'FAQ', desc: 'Questions and answers', sections: ['hero', 'faq', 'cta'] },
  text: { label: 'Text page', desc: 'Policies, terms or long text', sections: ['hero', 'text'] },
};
const NO_NAME = new Set(['blank', 'custom']);

// A miniature of the page: its sections' thumbnails stacked.
const pagePreview = (types) => el('div', { class: 'tpl__pv' }, types.slice(0, 5).map((t) => el('div', { html: THUMBS[t] || '<div class="thumb"></div>' })));

function saveAsTemplate(i) {
  const p = state.doc.pages[i];
  const name = prompt('Name this page template', p.title);
  if (name === null) return;
  (state.doc.templates ||= []).push({ id: uid('tpl'), name: name.trim() || p.title, sections: clone(p.sections) });
  commit();
  toast('Saved. Find it under Pages → New → Your templates.');
}

function openAddPage() {
  const builtIn = Object.entries(PAGE_TEMPLATES).filter(([, t]) => t.sections.every((type) => BLOCKS[type]));
  let tpl = 'blank';
  let auto = '';
  const name = el('input', { class: 'in', placeholder: 'e.g. Pricing', value: '' });
  const box = el('div');
  const choose = (key, suggested) => {
    tpl = key;
    if (!name.value.trim() || name.value === auto) { name.value = suggested; auto = suggested; }
    paint();
  };
  const card = (key, label, desc, types, suggested, extra = null) => el('div', { class: `tpl${key === tpl ? ' is-on' : ''}` },
    el('button', { type: 'button', class: 'tpl__main', onclick: () => choose(key, suggested) }, pagePreview(types), el('strong', {}, label), el('small', {}, desc)), extra);
  function paint() {
    const mine = (state.doc.templates || []).filter((t) => Array.isArray(t.sections));
    box.replaceChildren(
      el('p', { class: 'p-sub' }, 'Start from a template'),
      el('div', { class: 'templates' }, builtIn.map(([k, t]) => card(k, t.label, t.desc, t.sections, NO_NAME.has(k) ? '' : t.label))),
      ...(mine.length ? [el('p', { class: 'p-sub' }, 'Your templates'), el('div', { class: 'templates' }, mine.map((t) =>
        card(`mine:${t.id}`, t.name, `${t.sections.length} section${t.sections.length === 1 ? '' : 's'}`, t.sections.map((x) => x.type), t.name,
          el('button', { type: 'button', class: 'tpl__del', title: 'Remove this template', onclick: () => {
            state.doc.templates = state.doc.templates.filter((x) => x.id !== t.id);
            commit();
            if (tpl === `mine:${t.id}`) tpl = 'blank';
            paint();
          } }, ico('trash')))))] : []),
      el('p', { class: 'p-sub' }, 'Or copy one of your pages'),
      el('div', { class: 'templates' }, state.doc.pages.map((p) =>
        card(`page:${p.id}`, p.title, `${p.sections.length} section${p.sections.length === 1 ? '' : 's'}`, p.sections.map((x) => x.type), `${p.title} copy`))));
    hydrateIcons(box);
  }
  paint();
  const create = () => {
    const title = name.value.trim() || 'New page';
    let secs;
    if (tpl.startsWith('mine:')) secs = clone((state.doc.templates || []).find((t) => `mine:${t.id}` === tpl)?.sections || []);
    else if (tpl.startsWith('page:')) secs = clone(state.doc.pages.find((p) => `page:${p.id}` === tpl)?.sections || []);
    if (secs) secs.forEach((x) => { x.id = uid(); });
    else {
      secs = PAGE_TEMPLATES[tpl].sections.map((type) => newSection(type, type === 'hero'
        ? { layout: 'center', pad: 'normal', eyebrow: title, heading: title, text: 'A short introduction to this page.', secondary: { label: '', href: '' } } : {}));
    }
    state.doc.pages.push({ id: uid('p'), title, slug: uniqueSlug(slugify(title) || 'page'), showInNav: true, seoTitle: '', seoDescription: '', sections: secs });
    commit();
    closeModal();
    goToPage(state.doc.pages.length - 1);
    toast(`Page “${title}” created`);
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  openModal('New page', el('div', { class: 'new-page' },
    el('div', { class: 'f new-page__name' }, el('label', {}, 'Page name'), name),
    box,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'ed-btn', onclick: closeModal }, 'Cancel'), el('button', { type: 'button', class: 'ed-btn ed-btn--primary', onclick: create }, 'Create page'))));
  setTimeout(() => name.focus(), 50);
}

function panelTheme(box) {
  const t = state.doc.theme;
  box.append(panelHead('Design', 'droplet'));
  const body = el('div', { class: 'p-body' });
  const set = (k, v, soon = false) => { t[k] = v; applyTheme(); if (soon) commitSoon(); else { commit(); renderPanel(); } };
  body.append(el('p', { class: 'p-sub' }, 'Color themes'), el('div', { class: 'presets' }, Object.entries(THEME_PRESETS).map(([k, p]) =>
    el('button', { type: 'button', class: `preset${t.preset === k ? ' is-on' : ''}`, onclick: () => {
      Object.assign(t, { preset: k, primary: p.primary, accent: p.accent, dark: p.dark, bg: p.bg, surface: p.surface, text: p.text });
      applyTheme(); commit(); renderPanel(); if (state.sel) renderInspector();
    } }, el('span', { class: 'preset__sw' }, ...[p.dark, p.primary, p.accent, p.surface].map((c) => el('span', { style: `background:${c}` }))), p.name))));
  body.append(el('p', { class: 'p-sub' }, 'Colors'));
  const colorRows = [['primary', 'Brand color'], ['accent', 'Accent'], ['dark', 'Dark sections'], ['surface', 'Tinted sections'], ['text', 'Text']];
  for (const [k, l] of colorRows) {
    const f = fieldControl({ type: 'color', label: l }, k, t[k], (path, v, o) => { t.preset = 'custom'; set(path, v, o?.soon); }, t, () => {});
    body.append(f);
  }
  body.append(el('p', { class: 'p-sub' }, 'Typography'));
  const fontSel = (k, l) => el('div', { class: 'f' }, el('label', {}, l), el('select', { onchange: (e) => set(k, e.target.value) },
    Object.keys(FONTS).map((f) => el('option', { value: f, selected: t[k] === f, style: `font-family:'${f}'` }, f))));
  body.append(fontSel('headingFont', 'Headings'), fontSel('bodyFont', 'Body text'));
  body.append(el('p', { class: 'p-sub' }, 'Shape'));
  body.append(fieldControl({ type: 'segmented', label: 'Corners', options: [['sharp', 'Sharp'], ['soft', 'Soft'], ['round', 'Round']] }, 'radius', t.radius, (p, v) => set(p, v), t));
  body.append(fieldControl({ type: 'segmented', label: 'Buttons', options: [['rounded', 'Rounded'], ['pill', 'Pill']] }, 'buttons', t.buttons, (p, v) => set(p, v), t));
  const css = el('textarea', { class: 'code-in', rows: 8, spellcheck: false, placeholder: '.hero__title { letter-spacing: -0.05em; }',
    oninput: (e) => { t.customCSS = e.target.value; applyTheme(); commitSoon(); } });
  css.value = t.customCSS || '';
  body.append(el('details', { class: 'adv', open: !!t.customCSS }, el('summary', {}, ico('code'), 'Custom CSS (advanced)'),
    el('p', { class: 'f__help' }, 'Added after the theme styles on every page.'), css));
  box.append(body);
}

function panelSite(box) {
  const s = state.doc.site;
  box.append(panelHead('Site settings', 'sliders'));
  const body = el('div', { class: 'p-body' });
  body.append(el('div', { class: 'connected' },
    el('span', { class: 'connected__dot' }),
    el('div', {}, el('strong', {}, 'Connected to ', el('a', { href: `${SITE}/`, target: '_blank', rel: 'noopener' }, new URL(SITE).host)),
      el('small', {}, `Publishes to ${CONFIG.repo.owner}/${CONFIG.repo.name} (${CONFIG.repo.branch}) · theme v${theme.EDITOR_API}`))));
  const fields = [
    { key: 'name', label: 'Business name', type: 'text' },
    { key: 'url', label: 'Site address', type: 'text', help: 'Your full web address, e.g. https://roetechnologyservices.com. Used for search engines and share links.' },
    { key: 'description', label: 'Site description (for search engines)', type: 'textarea' },
    { type: 'note', text: 'Contact details are used in the Contact section and the footer.' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'location', label: 'Location / service area', type: 'text' },
    { key: 'formEndpoint', label: 'Form endpoint (optional)', type: 'text', help: 'Paste your Formspree (or similar) https:// URL to receive form messages by email. Spam protection is built in. Leave empty to open the visitor’s email app instead.' },
    ...(has('reviews') ? [{ key: 'reviewUrl', label: 'Review page (optional)', type: 'text', placeholder: 'https://g.page/r/…/review',
      help: 'Where “Leave us a review” buttons go. In your Google Business Profile choose “Ask for reviews” and copy the link.' }] : []),
  ];
  body.append(el('p', { class: 'p-sub' }, 'Business'));
  renderFields(body, fields, s, () => renderCanvas(), '', renderPanel);
  if (has('hours')) panelHours(body, s);
  if (has('call-button')) {
    body.append(el('p', { class: 'p-sub' }, 'Call button'));
    const on = (d) => !!d.callButton?.enabled;
    renderFields(body, [
      { key: 'callButton.enabled', label: 'Show a “Call now” button', type: 'toggle', help: 'Floats at the bottom of the screen and calls your phone number in one tap.' },
      { key: 'callButton.label', label: 'Button text', type: 'text', placeholder: 'Call now', when: on },
      { key: 'callButton.text', label: 'Also show a “Text us” button', type: 'toggle', when: on },
      { key: 'callButton.textLabel', label: 'Text button text', type: 'text', placeholder: 'Text us', when: (d) => on(d) && !!d.callButton?.text },
      { key: 'callButton.show', label: 'Show on', type: 'segmented', default: 'phones', options: [['phones', 'Phones only'], ['all', 'All screens']], when: on },
    ], s, () => renderCanvas(), '', renderPanel);
    if (s.callButton?.enabled && String(s.phone || '').replace(/\D/g, '').length < 3) body.append(el('p', { class: 'f__help f__help--warn' }, 'Add your phone number above. The button is only shown once there is one.'));
    else if (s.callButton?.enabled && s.callButton.show !== 'all') body.append(el('p', { class: 'f__help' }, 'Switch the preview size at the top to Mobile to see it.'));
  }
  if (has('analytics')) panelStats(body, s);
  panelAnnouncement(body, s);
  body.append(el('p', { class: 'p-sub' }, 'Social links'), el('p', { class: 'p-hint' }, 'Shown as icons in the footer. Leave empty to hide.'));
  renderFields(body, SOCIAL.map(([k, l]) => ({ key: `social.${k}`, label: l, type: 'text' })), s, () => renderCanvas(), '', renderPanel);
  if (has('verification')) panelSearchEngines(body, s);
  body.append(el('p', { class: 'p-sub' }, 'Branding & sharing'));
  renderFields(body, [
    { key: 'favicon', label: 'Browser tab icon', type: 'image', help: 'A square image, at least 64×64.' },
    { key: 'shareImage', label: 'Share image', type: 'image', help: 'Shown when your site is shared on social media or messages. 1200×630 works best.' },
  ], s, () => {}, '', renderPanel);
  if (has('redirects')) panelRedirects(body);
  if (has('not-found')) panelNotFound(body, s);
  panelEditorLogin(body);
  body.append(el('p', { class: 'p-sub' }, 'Header & footer'),
    el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: () => select('__header', { scroll: true }) }, ico('layout'), 'Edit header & footer'));
  body.append(el('p', { class: 'p-sub' }, 'Backup'),
    el('div', { style: 'display:grid;gap:6px' },
      el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: downloadJSON }, ico('download'), 'Download backup (site.json)'),
      el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: importJSON }, ico('upload'), 'Restore from file'),
      el('button', { type: 'button', class: 'ed-btn ed-btn--block ed-btn--danger', onclick: resetToPublished }, ico('refresh'), 'Discard draft (load live version)')));
  box.append(body);
}

// The bar above the header, optionally only between two dates (site feature
// "announcement-dates"), e.g. for holiday hours or a sale.
function panelAnnouncement(body, s) {
  body.append(el('p', { class: 'p-sub' }, 'Announcement bar'));
  const on = (d) => !!d.announcement?.enabled;
  const when = el('p', { class: 'f__help ann-when' });
  const paintWhen = () => {
    const ann = s.announcement || {};
    when.hidden = !has('announcement-dates') || !ann.enabled || !(ann.start || ann.end);
    if (when.hidden) return;
    const { start, end, state: st } = theme.announceWindow(ann, localToday());
    const never = start && end && end < start;
    when.classList.toggle('f__help--warn', !!never || st === 'after');
    when.textContent = never ? 'The last day is before the first day, so the bar never shows.'
      : st === 'before' ? `Visitors see it from ${formatDate(start)}${end ? ` through ${formatDate(end)}` : ''}.`
        : st === 'after' ? `It ended on ${formatDate(end)}, so visitors don’t see it. Pick new days or turn it off.`
          : end ? `Showing now, through ${formatDate(end)}.` : 'Showing now.';
  };
  renderFields(body, [
    { key: 'announcement.enabled', label: 'Show a bar above the header', type: 'toggle' },
    { key: 'announcement.text', label: 'Message', type: 'text', when: on },
    { key: 'announcement.linkText', label: 'Link text (optional)', type: 'text', when: on },
    { key: 'announcement.link', label: 'Link', type: 'link', when: on },
    ...(has('announcement-dates') ? [
      { key: 'announcement.start', label: 'First day (optional)', type: 'date', when: on },
      { key: 'announcement.end', label: 'Last day (optional)', type: 'date', when: on,
        help: 'Show it only on these days, e.g. for holiday hours or a sale. Leave empty to show it until you turn it off.' },
    ] : []),
  ], s, () => { renderCanvas(); paintWhen(); }, '', renderPanel);
  paintWhen();
  body.append(when);
}

// The page visitors see for an address that doesn't exist (site feature "not-found").
function panelNotFound(body, s) {
  const nf = theme.NOT_FOUND || {};
  body.append(el('p', { class: 'p-sub' }, 'Page not found'),
    el('p', { class: 'p-hint' }, 'Shown when someone opens an address that doesn’t exist on your site, like an old or mistyped link. Empty boxes use the standard wording.'));
  renderFields(body, [
    { key: 'notFound.heading', label: 'Heading', type: 'text', placeholder: nf.heading },
    { key: 'notFound.text', label: 'Message', type: 'textarea', placeholder: nf.text },
    { key: 'notFound.button', label: 'Button text', type: 'text', placeholder: nf.button },
    { key: 'notFound.links', label: 'List your pages below the button', type: 'toggle', default: true },
  ], s, () => {}, '', renderPanel);
  body.append(el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: async () => {
    flushCommit(); await saveDraft();
    window.open(`preview.html?path=${encodeURIComponent('/this-page-does-not-exist/')}`, '_blank', 'noopener');
  } }, ico('eye'), 'Preview the page'));
}

const LANGUAGES = [['en', 'English'], ['en-US', 'English (United States)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['zh', 'Chinese'], ['vi', 'Vietnamese'], ['ko', 'Korean'], ['ar', 'Arabic']];

// Business hours (site feature "hours"): a weekly schedule in the business's
// time zone. Stored as site.hours.week = { mon: '08:00-18:00', …, sun: '' }.
const TIME_ZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();
const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();

function panelHours(body, s) {
  const DAYS = theme.DAYS;
  body.append(el('p', { class: 'p-sub' }, 'Business hours'));
  const hours = s.hours || {};
  const changed = (rerender = true) => { commit(); renderCanvas(); if (rerender) renderPanel(); else paintSummary(); };
  body.append(el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Show business hours', el('input', { type: 'checkbox', 'data-path': 'hours', checked: !!hours.enabled, onchange: (e) => {
    s.hours = { timezone: BROWSER_TZ, note: '', week: { mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-17:00', sat: '', sun: '' }, ...s.hours, enabled: e.target.checked };
    changed();
  } })), el('p', { class: 'f__help' }, 'Shown in the Contact section and the footer with “Open now”, and given to Google.')));
  if (!hours.enabled) return;
  const week = (hours.week ||= {});
  const summary = el('p', { class: 'hours-summary' });
  const paintSummary = () => {
    const st = theme.openStatus(s.hours);
    summary.replaceChildren(el('span', {}, theme.hoursSummary(s.hours) || 'Closed every day'),
      st ? el('span', { class: `hours-badge${st.open ? ' is-open' : ''}` }, st.text) : null);
  };
  const rows = DAYS.map(([k, full]) => {
    const r = theme.parseRange(week[k]);
    const raw = String(week[k] || '').split('-');
    const open = el('input', { type: 'time', class: 'in', value: r ? raw[0] : '09:00', disabled: !week[k], 'data-path': `hours.week.${k}`, 'aria-label': `${full} opening time` });
    const close = el('input', { type: 'time', class: 'in', value: r ? raw[1] : '17:00', disabled: !week[k], 'aria-label': `${full} closing time` });
    const isOpen = el('input', { type: 'checkbox', checked: !!week[k], 'aria-label': `Open on ${full}` });
    const save = () => { week[k] = isOpen.checked ? `${open.value || '09:00'}-${close.value || '17:00'}` : ''; open.disabled = close.disabled = !isOpen.checked; row.classList.toggle('is-closed', !isOpen.checked); changed(false); };
    isOpen.addEventListener('change', save);
    open.addEventListener('change', save);
    close.addEventListener('change', save);
    const row = el('div', { class: `hours-row${week[k] ? '' : ' is-closed'}${week[k] && !r ? ' is-bad' : ''}` },
      el('label', { class: 'hours-row__day' }, isOpen, el('span', {}, full.slice(0, 3))), open, el('span', { class: 'hours-row__to' }, 'to'), close,
      el('span', { class: 'hours-row__closed' }, 'Closed'));
    return row;
  });
  const copy = el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: () => {
    ['tue', 'wed', 'thu', 'fri'].forEach((k) => { week[k] = week.mon || ''; });
    changed();
    toast('Monday’s hours copied to Tuesday–Friday');
  } }, ico('copy'), 'Copy Monday to weekdays');
  const zones = TIME_ZONES.includes(hours.timezone) || !hours.timezone ? TIME_ZONES : [hours.timezone, ...TIME_ZONES];
  const tz = el('select', { onchange: (e) => { s.hours.timezone = e.target.value; changed(false); } },
    (zones.length ? zones : [hours.timezone || BROWSER_TZ]).map((z) => el('option', { value: z, selected: z === (hours.timezone || BROWSER_TZ) }, z.replace(/_/g, ' '))));
  const note = el('input', { class: 'in', value: hours.note || '', placeholder: 'e.g. Emergency support by appointment', 'data-path': 'hours.note', oninput: (e) => { s.hours.note = e.target.value; commitSoon(); renderCanvas(); } });
  paintSummary();
  body.append(el('div', { class: 'hours-grid' }, rows), el('div', { class: 'hours-actions' }, copy), summary,
    el('div', { class: 'f' }, el('label', {}, 'Time zone'), tz, el('p', { class: 'f__help' }, '“Open now” is worked out for this time zone, wherever the visitor is.')),
    el('div', { class: 'f' }, el('label', {}, 'Note (optional)'), note));
}

// Visitor stats (site feature "analytics"): Cloudflare Web Analytics or GoatCounter.
function panelStats(body, s) {
  body.append(el('p', { class: 'p-sub' }, 'Visitor stats'));
  const a = s.analytics || {};
  renderFields(body, [
    { key: 'analytics.provider', label: 'Count visitors with', type: 'select', options: [['', 'Nothing (off)'], ['cloudflare', 'Cloudflare Web Analytics'], ['goatcounter', 'GoatCounter']],
      help: 'Both are free, use no cookies and need no cookie banner.' },
  ], s, () => {}, '', renderPanel);
  if (!a.provider) return;
  const cf = a.provider === 'cloudflare';
  const msg = el('p', { class: 'f__help stats-state' });
  const paint = () => {
    const ok = theme.analyticsFor?.(s);
    const typed = String(s.analytics?.id || '').trim();
    msg.className = `f__help stats-state${ok || !typed ? '' : ' f__help--warn'}`;
    msg.replaceChildren(ok ? 'Stats start counting once you publish. ' : typed ? 'That doesn’t look right yet.' : '',
      ok ? el('a', { href: cf ? 'https://dash.cloudflare.com/?to=/:account/web-analytics' : `https://${ok.id}.goatcounter.com`, target: '_blank', rel: 'noopener' }, 'View your stats') : '');
  };
  renderFields(body, [{ key: 'analytics.id', label: cf ? 'Site token' : 'Site code', type: 'text', placeholder: cf ? '32 letters and numbers' : 'e.g. roetech',
    help: cf ? 'In Cloudflare open Web Analytics → Add a site, enter your address, choose the JavaScript snippet and copy the token (the value after "token").'
      : 'Sign up free at goatcounter.com. Your code is the first part of your stats address, e.g. roetech for roetech.goatcounter.com.' }], s, paint, '', renderPanel);
  paint();
  body.append(msg);
}

// Editor login. The editor can sit behind Cloudflare Access (sign in with
// Google or a code sent to your email). Cloudflare then answers
// /cdn-cgi/access/get-identity on the editor's own address with who is signed in.
async function accessIdentity() {
  try {
    const res = await fetch('/cdn-cgi/access/get-identity', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok || !/json/.test(res.headers.get('content-type') || '')) return null;
    const id = await res.json();
    return id?.email ? { email: String(id.email), name: String(id.name || '') } : null;
  } catch { return null; }
}

function showAccount(id) {
  const box = $('#account');
  if (!box || !id) return;
  const btn = $('.ed-account__btn', box);
  const menu = $('.ed-account__menu', box);
  btn.textContent = (id.name || id.email).trim().charAt(0).toUpperCase();
  btn.title = `Signed in as ${id.email}`;
  $('.ed-account__email', box).textContent = id.email;
  box.hidden = false;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
}

const LOGIN_GUIDE = 'https://github.com/Bessv2/rts-editor#editor-login';
function panelEditorLogin(body) {
  body.append(el('p', { class: 'p-sub' }, 'Editor login'));
  if (state.access) {
    body.append(el('div', { class: 'login-state is-on' }, ico('shield-check'),
      el('div', {}, el('strong', {}, 'Protected with a login'), el('small', {}, `Signed in as ${state.access.email}. Only people you allow can open the editor.`),
        el('a', { href: '/cdn-cgi/access/logout' }, 'Sign out'))));
    return;
  }
  body.append(el('div', { class: 'login-state' }, ico('lock'),
    el('div', {}, el('strong', {}, 'No login yet'), el('small', {}, 'Anyone who finds this address can open the editor. They can’t publish without your GitHub token, but you can hide the editor completely behind a Google or email sign-in.'),
      el('a', { href: LOGIN_GUIDE, target: '_blank', rel: 'noopener' }, 'How to set up the login'))));
}

function panelSearchEngines(body, s) {
  const langs = LANGUAGES.some(([v]) => v === (s.lang || 'en')) ? LANGUAGES : [...LANGUAGES, [s.lang, s.lang]];
  body.append(el('p', { class: 'p-sub' }, 'Search engines'));
  renderFields(body, [{ key: 'lang', label: 'Site language', type: 'select', options: langs, help: 'Helps search engines and screen readers.' }], s, () => {}, '', renderPanel);
  // Accepts the bare code or the whole <meta> tag that Google or Bing shows.
  const code = (key, label, help) => el('div', { class: 'f' }, el('label', {}, label), el('input', { class: 'in', 'data-path': key, value: s[key] || '', placeholder: 'Paste the code or the whole <meta> tag', spellcheck: false,
    onchange: (e) => {
      const v = e.target.value.trim();
      const m = v.match(/content\s*=\s*["']?([^"'\s>]+)/i);
      const clean = (m ? m[1] : v).replace(/[^\w-]/g, '');
      if (clean) s[key] = clean; else delete s[key];
      e.target.value = clean;
      commit();
    } }), el('p', { class: 'f__help' }, help));
  body.append(
    code('googleVerification', 'Google Search Console code', 'In Search Console, add your site, choose “HTML tag” and paste it here. Publish, then press Verify in Search Console.'),
    code('bingVerification', 'Bing Webmaster Tools code', 'In Bing Webmaster Tools, choose “Meta tag” and paste it here.'));
}

function panelRedirects(body) {
  const list = (state.doc.redirects ||= []);
  body.append(el('p', { class: 'p-sub' }, 'Redirects'), el('p', { class: 'p-hint' }, 'Send visitors from an old address to a new one. Added automatically when you change the address of a live page or post.'));
  if (list.length) {
    body.append(el('div', { class: 'redirects' }, list.map((r, i) => el('div', { class: 'redirect-row' },
      el('span', { class: 'redirect-row__txt' }, el('code', {}, r.from), ' → ', el('code', {}, r.to)),
      el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--sm ed-icon-btn--danger', title: 'Remove redirect', onclick: () => { list.splice(i, 1); commit(); renderPanel(); } }, ico('trash'))))));
  }
  const from = el('input', { class: 'in', placeholder: 'Old address, e.g. /old-page/' });
  const to = el('input', { class: 'in', placeholder: 'New address, e.g. /services/', list: linkSuggestions() });
  const add = () => {
    const f = theme.redirectFrom(from.value);
    if (!f) { toast('Use an old address like /old-page/ or /blog/old-post/.', { error: true }); return; }
    if (!to.value.trim()) { toast('Enter the new address.', { error: true }); return; }
    if (list.some((r) => theme.redirectFrom(r.from) === f)) { toast(`There is already a redirect from /${f}/.`, { error: true }); return; }
    list.push({ from: `/${f}/`, to: theme.redirectTo(to.value) });
    commit(); renderPanel();
  };
  body.append(el('div', { class: 'f-row redirect-add' }, from, to), el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: add }, ico('plus'), 'Add redirect'));
}

function panelHelp(box) {
  box.append(panelHead('How it works', 'help'));
  box.append(el('div', { class: 'p-body' },
    el('ol', { class: 'help-steps' },
      el('li', {}, el('strong', {}, 'Edit text on the page. '), 'Click any text in the preview and type.'),
      el('li', {}, el('strong', {}, 'Select a section '), 'to change images, buttons, icons, colors and spacing on the right.'),
      el('li', {}, el('strong', {}, 'Add sections '), 'from the Add tab. Reorder them with the arrows or drag in Layers.'),
      el('li', {}, el('strong', {}, 'Format text '), 'with **bold**, *italic* and [link text](https://…).'),
      el('li', {}, el('strong', {}, 'Reuse sections: '), 'copy a section and paste it on another page, or save it to reuse later.'),
      el('li', {}, el('strong', {}, 'Images: '), 'upload once in the Images tab, then pick from the Library anywhere. Any section can have a background image.'),
      el('li', {}, el('strong', {}, 'Change the look '), 'in Design — one click swaps the whole color theme.'),
      el('li', {}, el('strong', {}, 'History '), 'keeps saved versions, cloud drafts and every published version.'),
      el('li', {}, el('strong', {}, 'Your work saves automatically '), 'as a draft in this browser.'),
      el('li', {}, el('strong', {}, 'Click Publish '), 'to make it live. The site updates about a minute later.')),
    el('p', { class: 'p-sub' }, 'Shortcuts'),
    el('div', { class: 'kbd-list' },
      el('div', {}, 'Undo', el('kbd', {}, 'Ctrl Z')), el('div', {}, 'Redo', el('kbd', {}, 'Ctrl ⇧ Z')),
      el('div', {}, 'Delete selected section', el('kbd', {}, 'Del')), el('div', {}, 'Finish editing text', el('kbd', {}, 'Esc')),
      el('div', {}, 'Duplicate section', el('kbd', {}, 'Ctrl D')), el('div', {}, 'Copy / paste section', el('span', {}, el('kbd', {}, 'Ctrl C'), ' ', el('kbd', {}, 'Ctrl V'))),
      el('div', {}, 'Save draft', el('kbd', {}, 'Ctrl S')), el('div', {}, 'Jump to a page, section, post or setting', el('kbd', {}, 'Ctrl K')))));
}

// ---------------------------------------------------------------------------
// Data import / export / publish
function downloadJSON() {
  const blob = new Blob([`${JSON.stringify(state.doc, null, 2)}\n`], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'site.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importJSON() {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    try {
      const raw = JSON.parse(await input.files[0].text());
      if (!Array.isArray(raw.pages) || !raw.pages.length || !raw.site) throw new Error();
      state.doc = migrate(raw); state.page = 0; state.sel = null;
      commit(); refreshAll();
      toast('Site restored from file');
    } catch { toast('That file is not a valid site.json backup.', { error: true }); }
  });
  input.click();
}

async function resetToPublished() {
  if (!confirm('Discard your draft and load the live version? You can undo this.')) return;
  try {
    const live = await fetchPublished();
    state.doc = migrate(live.doc);
    await setBase(live.sha);
    state.page = 0; state.sel = null;
    commit(); refreshAll();
    toast('Loaded the live version', { action: 'Undo', onAction: undo });
  } catch (e) { toast(e.message, { error: true }); }
}

async function fetchPublished() {
  const res = await fetch(`${SITE}/content/site.json?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load content/site.json (${res.status})`);
  const text = await res.text();
  return { doc: JSON.parse(text), sha: await gitBlobSha(text).catch(() => '') };
}

function loadGH() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(GH_KEY) || '{}'); } catch { /* ignore */ }
  // Settings saved for a different site (or older settings for a different repo) are not reused.
  const same = saved.site ? saved.site === SITE_KEY : saved.owner === DEFAULT_REPO.owner && saved.repo === DEFAULT_REPO.repo;
  return same ? { ...DEFAULT_REPO, ...saved } : { ...DEFAULT_REPO };
}

function openPublish() {
  flushCommit();
  const gh = loadGH();
  const inp = (k, ph, type = 'text') => el('input', { class: 'in', type, value: gh[k] || '', placeholder: ph, autocomplete: 'off', spellcheck: false });
  const owner = inp('owner', 'GitHub user'); const repo = inp('repo', 'Repository'); const branch = inp('branch', 'main');
  const token = inp('token', 'github_pat_…', 'password');
  if (!gh.token && state.ghToken) token.value = state.ghToken;
  const remember = el('input', { type: 'checkbox', checked: !!gh.token });
  const msg = el('input', { class: 'in', value: 'Update site content' });
  const log = el('div', { class: 'log', hidden: true });
  const go = el('button', { type: 'button', class: 'ed-btn ed-btn--primary' }, ico('send'), 'Publish now');
  const write = (t, cls) => { log.hidden = false; log.append(el('div', { class: cls || '' }, t)); log.scrollTop = log.scrollHeight; };
  const found = publishChecks();
  const errors = found.filter((c) => c.level === 'error');
  const warnings = found.filter((c) => c.level === 'warning');
  const shown = [...errors, ...warnings];
  const checkBox = shown.length ? el('div', { class: `pub-checks${errors.length ? ' has-err' : ''}` },
    el('strong', {}, errors.length
      ? `${errors.length} problem${errors.length === 1 ? '' : 's'} must be fixed before you can publish`
      : `${warnings.length} thing${warnings.length === 1 ? '' : 's'} worth checking first (you can still publish)`),
    checkList(shown.slice(0, 5)),
    shown.length > 5 ? el('button', { type: 'button', class: 'pub-checks__all', onclick: () => { closeModal(); setTab('checkup'); } }, `See all ${shown.length} in Checkup`) : null) : null;
  if (errors.length) go.disabled = true;
  const test = el('button', { type: 'button', class: 'ed-btn' }, ico('check'), 'Test connection');
  const readCfg = () => ({ owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', token: token.value.trim() });
  const diagnose = async (cfg) => {
    write('Checking your GitHub connection…');
    const r = await checkAccess(cfg);
    write(r.message, r.ok ? 'ok' : 'err');
    if (r.fix) write(r.fix);
    return r;
  };
  test.addEventListener('click', async () => {
    const cfg = readCfg();
    log.replaceChildren();
    if (!cfg.owner || !cfg.repo || !cfg.token) { write('Fill in repository and token first.', 'err'); return; }
    test.disabled = true;
    try { await diagnose(cfg); } finally { test.disabled = false; }
  });
  go.addEventListener('click', async () => {
    const cfg = readCfg();
    if (!cfg.owner || !cfg.repo || !cfg.token) { write('Fill in repository and token first.', 'err'); return; }
    rememberGH(cfg, remember.checked);
    const moved = keepAllOldAddresses();
    if (moved.length) commit();
    const blocking = publishChecks().filter((c) => c.level === 'error');
    if (blocking.length) { log.replaceChildren(); blocking.forEach((c) => write(c.message, 'err')); write('Fix these, then publish again.', 'err'); return; }
    go.disabled = true;
    log.replaceChildren();
    for (const [from, to] of moved) write(`${from} now forwards to ${to}.`);
    // Pages are built with the site code this tab loaded; don't publish with an outdated copy.
    if (await codeChangedSince(cfg, OPENED_AT).catch(() => false)) {
      write('Your site’s design code was updated after you opened the editor. Your draft is saved: reload the editor (in a few minutes, once the site has updated), then publish.', 'err');
      go.disabled = false;
      return;
    }
    try {
      const r = await publishToGitHub({ ...cfg, message: msg.value.trim() || 'Update site content', doc: state.doc, log: write, origin: SITE, buildSite, staleFiles,
        base: state.base,
        confirmOverwrite: () => confirm('Your site was changed somewhere else (another computer, the old editor or GitHub) after you started editing.\n\nPublish anyway and replace those changes with yours? Choose Cancel to keep them; you can open them from History → Published versions.') });
      await setBase(r.contentSha);
      state.published = JSON.stringify(state.doc);
      saveDraft();
      addVersion(`Published: ${msg.value.trim() || 'Update site content'}`).catch(() => {});
      updateTopbar();
      write('Done! Your site will update in about a minute.', 'ok');
      if (r.commitUrl) log.append(el('div', {}, el('a', { href: r.commitUrl, target: '_blank', rel: 'noopener', style: 'color:#93c5fd' }, 'View commit on GitHub')));
      toast('Published! Changes go live in about a minute.');
    } catch (e) {
      write(e instanceof PublishCancelled ? e.message : `Error: ${e.message}`, 'err');
      // Nothing on the site changes unless the very last step succeeds.
      if ([401, 403, 404].includes(e.status)) { write('Your live site was not changed.'); await diagnose(cfg).catch(() => {}); }
    } finally { go.disabled = false; }
  });

  const ghPane = el('div', {},
    checkBox,
    el('p', {}, 'Publishing saves your changes to your website’s GitHub repository. GitHub Pages then updates the live site automatically.'),
    el('details', { class: 'note' }, el('summary', { style: 'cursor:pointer;font-weight:600' }, 'First time? Create an access token'),
      el('ol', { class: 'steps-mini', style: 'margin-top:8px' },
        el('li', {}, 'Open ', el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'GitHub → Fine-grained tokens'), '.'),
        el('li', {}, 'Repository access: “Only select repositories” → your site repository.'),
        el('li', {}, 'Permissions → Repository → Contents: “Read and write”.'),
        el('li', {}, 'Generate, copy the token and paste it below.'))),
    el('div', { class: 'f-row' }, el('div', { class: 'f' }, el('label', {}, 'Owner'), owner), el('div', { class: 'f' }, el('label', {}, 'Repository'), repo)),
    el('div', { class: 'f-row' }, el('div', { class: 'f' }, el('label', {}, 'Branch'), branch), el('div', { class: 'f' }, el('label', {}, 'Access token'), token)),
    el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Remember token on this computer', remember)),
    el('div', { class: 'f' }, el('label', {}, 'Change note'), msg),
    log,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'ed-btn', onclick: closeModal }, 'Cancel'), test, go));

  const filePane = el('div', { hidden: true },
    el('p', {}, 'Prefer to publish by hand? Download your content file and replace content/site.json in the repository.'),
    el('div', { class: 'note' }, 'Uploaded images are embedded inside the file when you publish this way.'),
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'ed-btn ed-btn--primary', onclick: downloadJSON }, ico('download'), 'Download site.json')));

  const tabs = el('div', { class: 'ed-tabs' });
  const tab = (label, pane, on) => el('button', { type: 'button', class: on ? 'is-on' : '', onclick: (e) => {
    $$('button', tabs).forEach((b) => b.classList.remove('is-on'));
    e.currentTarget.classList.add('is-on');
    ghPane.hidden = pane !== ghPane; filePane.hidden = pane !== filePane;
  } }, label);
  tabs.append(tab('Publish to GitHub', ghPane, true), tab('Download file', filePane));
  openModal('Publish your site', el('div', {}, tabs, ghPane, filePane));
}

// ---------------------------------------------------------------------------
// GitHub connection shared by publish, history and cloud drafts
function rememberGH(cfg, persist) {
  state.ghToken = cfg.token;
  try { localStorage.setItem(GH_KEY, JSON.stringify({ ...cfg, token: persist ? cfg.token : '', site: SITE_KEY })); } catch { /* ignore */ }
}

function currentGH() {
  const gh = loadGH();
  const token = gh.token || state.ghToken;
  return token ? { ...gh, token } : null;
}

function needGH(reason) {
  const ready = currentGH();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const gh = loadGH();
    const inp = (k, ph, type = 'text') => el('input', { class: 'in', type, value: gh[k] || '', placeholder: ph, autocomplete: 'off', spellcheck: false });
    const owner = inp('owner', 'GitHub user'); const repo = inp('repo', 'Repository'); const branch = inp('branch', 'main');
    const token = inp('token', 'github_pat_…', 'password');
    const remember = el('input', { type: 'checkbox' });
    const go = () => {
      const cfg = { owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', token: token.value.trim() };
      if (!cfg.owner || !cfg.repo || !cfg.token) { toast('Fill in repository and token first.', { error: true }); return; }
      rememberGH(cfg, remember.checked);
      closeModal();
      resolve(cfg);
    };
    openModal('Connect to GitHub', el('div', {},
      el('p', {}, reason),
      el('div', { class: 'f-row' }, el('div', { class: 'f' }, el('label', {}, 'Owner'), owner), el('div', { class: 'f' }, el('label', {}, 'Repository'), repo)),
      el('div', { class: 'f-row' }, el('div', { class: 'f' }, el('label', {}, 'Branch'), branch), el('div', { class: 'f' }, el('label', {}, 'Access token'), token)),
      el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Remember token on this computer', remember)),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'ed-btn', onclick: () => { closeModal(); resolve(null); } }, 'Cancel'),
        el('button', { type: 'button', class: 'ed-btn ed-btn--primary', onclick: go }, 'Continue'))));
    setTimeout(() => token.focus(), 50);
  });
}

// ---------------------------------------------------------------------------
// Blog: posts (full articles with their own page) and blurbs (short notes)
const findPost = (id) => (state.doc.posts || []).find((p) => p.id === id);
const isScheduled = (p) => has('scheduled-posts') && p.published !== false && String(p.date || '').slice(0, 10) > theme.today();
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const byDate = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

function uniquePostSlug(base, id) {
  const root = base || 'post';
  let slug = root;
  let n = 2;
  while (state.doc.posts.some((p) => p.slug === slug && p.id !== id)) slug = `${root}-${n++}`;
  return slug;
}

function newPost(kind) {
  const p = { id: uid('post'), kind, title: kind === 'post' ? 'Untitled post' : '', slug: '', date: localToday(), published: true, tags: '', image: '', summary: '', body: '', link: '' };
  p.slug = uniquePostSlug(kind === 'post' ? 'untitled-post' : `note-${p.date}`, p.id);
  state.doc.posts.unshift(p);
  commit();
  openPost(p.id);
}

function openPost(id) {
  flushCommit();
  state.post = id;
  state.sel = null;
  if (state.tab !== 'blog') { state.tab = 'blog'; $$('.ed-rail button').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === 'blog')); }
  renderCanvas({ keepScroll: false });
  renderInspector();
  renderPanel();
  syncUrl();
}

function closePost() {
  flushCommit();
  state.post = null;
  renderCanvas({ keepScroll: false });
  renderInspector();
  renderPanel();
  syncUrl();
}

function deletePost(id) {
  const p = findPost(id);
  if (!p || !confirm(`Delete “${postTitle(p) || 'this entry'}”? You can undo this.`)) return;
  state.doc.posts = state.doc.posts.filter((x) => x.id !== id);
  commit();
  closePost();
  toast('Deleted', { action: 'Undo', onAction: undo });
}

function panelBlog(box) {
  const current = state.post && findPost(state.post);
  if (current) { panelPostEditor(box, current); return; }
  box.append(panelHead('Blog', 'pen'));
  const body = el('div', { class: 'p-body' },
    el('div', { class: 'f-row' },
      el('button', { type: 'button', class: 'ed-btn ed-btn--primary', onclick: () => newPost('post') }, ico('pen'), 'New post'),
      el('button', { type: 'button', class: 'ed-btn', onclick: () => newPost('blurb') }, ico('sparkle'), 'New blurb')),
    el('p', { class: 'p-hint', style: 'margin-top:10px' }, 'Posts are full articles with their own page. Blurbs are short notes, tips or links you like.'));
  if (!state.doc.pages.some((pg) => pg.sections.some((sec) => sec.type === 'blogfeed'))) {
    body.append(el('div', { class: 'p-callout' }, ico('arrow-right'), 'Add a “Blog feed” section to a page to show your posts.'));
  }
  const posts = [...state.doc.posts].sort(byDate);
  body.append(el('p', { class: 'p-sub' }, `All entries (${posts.length})`));
  body.append(posts.length
    ? el('div', { class: 'post-list' }, posts.map((p) => el('button', { type: 'button', class: 'post-row', onclick: () => openPost(p.id) },
      el('span', { class: 'layer__icon' }, ico((p.kind || 'post') === 'blurb' ? 'sparkle' : 'pen')),
      el('span', { class: 'layer__txt' }, el('strong', {}, postTitle(p) || 'Untitled'), el('small', {}, `${formatDate(p.date)} · ${(p.kind || 'post') === 'blurb' ? 'Blurb' : 'Post'}`)),
      p.published === false ? el('span', { class: 'badge' }, 'Draft') : isScheduled(p) ? el('span', { class: 'badge badge--soon', title: `Goes live on ${formatDate(p.date)}` }, 'Scheduled') : null)))
    : el('p', { class: 'p-hint' }, 'Nothing here yet. Write your first post!'));
  box.append(body);
}

function panelPostEditor(box, p) {
  const blurb = (p.kind || 'post') === 'blurb';
  box.append(el('div', { class: 'p-head' },
    el('button', { type: 'button', class: 'ed-icon-btn', title: 'Back to all entries', onclick: closePost }, el('span', { class: 'flip' }, ico('arrow-right'))),
    el('h2', {}, blurb ? 'Edit blurb' : 'Edit post'),
    el('button', { type: 'button', class: 'ed-icon-btn ed-icon-btn--danger', title: 'Delete', onclick: () => deletePost(p.id) }, ico('trash'))));
  const body = el('div', { class: 'p-body' });
  const preview = () => renderCanvas();
  const autoSlug = () => {
    if (!blurb && !p.slugLocked && !publishedPath('post', p.id)) {
      p.slug = uniquePostSlug(slugify(postTitle(p)) || 'post', p.id);
      const input = $('#panel [data-path="slug"]');
      if (input && document.activeElement !== input) input.value = p.slug;
    }
    preview();
  };
  renderFields(body, [
    { key: 'kind', label: 'Type', type: 'segmented', options: [['post', 'Post'], ['blurb', 'Blurb']] },
    { key: 'published', label: 'Show on website', type: 'toggle', help: `Turn off to keep working on it without it appearing on your site. ${NOT_SECRET}` },
  ], p, preview, '', renderPanel);
  renderFields(body, [{ key: 'title', label: blurb ? 'Title (optional)' : 'Title', type: 'text' }], p, autoSlug, '', renderPanel);
  renderFields(body, [
    { key: 'date', label: 'Date', type: 'date', help: has('scheduled-posts') ? 'Pick a future date to schedule it: it goes live on that day by itself.' : undefined },
    { key: 'tags', label: 'Tags', type: 'text', help: 'Separate with commas, e.g. Security, Tips' },
    ...(blurb ? [
      { key: 'body', label: 'Blurb', type: 'markdown', rows: 6, placeholder: 'A quick thought, tip or something you liked…' },
      { key: 'link', label: 'Source link (optional)', type: 'text', help: 'Shown as “via example.com”.' },
    ] : [
      { key: 'image', label: 'Cover image', type: 'image' },
      { key: 'summary', label: 'Summary', type: 'textarea', help: 'One or two sentences shown on the blog card and in search results.' },
      { key: 'body', label: 'Article', type: 'markdown', rows: 18 },
      { key: 'link', label: 'Source link (optional)', type: 'text', help: 'Credit an article you are writing about.' },
    ]),
  ], p, preview, '', renderPanel);
  if (!blurb) {
    renderFields(body, [{ key: 'slug', label: 'Web address', type: 'text', help: has('redirects')
      ? `The end of this post’s link (yoursite.com/${POSTS_BASE}/…/). If the post is already live, visitors using the old link are sent to the new one.`
      : `The end of this post’s link (yoursite.com/${POSTS_BASE}/…/). Changing it breaks links people already shared.` }], p, () => {
      p.slug = uniquePostSlug(slugify(p.slug) || 'post', p.id);
      p.slugLocked = true;
      preview();
    }, '', renderPanel);
  }
  box.append(body);
}

// ---------------------------------------------------------------------------
// Media library
let libraryCache;
function loadLibrary() {
  libraryCache ||= fetch(`${SITE}/assets/library/manifest.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return libraryCache;
}

function addToMedia(src, name = 'Image') {
  state.doc.media ||= [];
  if (!state.doc.media.some((m) => m.src === src)) state.doc.media.unshift({ id: uid('img'), src, name, addedAt: Date.now() });
}

// Short reference for post text, so uploaded images don't paste huge data into it.
function mediaRef(src) {
  if (!String(src).startsWith('data:')) return src;
  const m = (state.doc.media || []).find((x) => x.src === src);
  if (!m) return src;
  m.id ||= uid('img');
  return `media:${m.id}`;
}

const IMAGE_KEYS = new Set(['image', 'bgImage', 'logo', 'favicon', 'shareImage']);
function siteImages() {
  const out = new Map((state.doc.media || []).map((m) => [m.src, { ...m, uploaded: true }]));
  (function walk(node, key) {
    if (Array.isArray(node)) node.forEach((n) => walk(n, key));
    else if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => walk(v, k));
    else if (typeof node === 'string' && node && IMAGE_KEYS.has(key) && !out.has(node) && !node.startsWith('assets/library/')) out.set(node, { src: node, name: node.startsWith('data:') ? 'Uploaded image' : node.split('/').pop() });
  })({ site: state.doc.site, pages: state.doc.pages, saved: state.doc.saved, posts: state.doc.posts }, '');
  return [...out.values()];
}

async function uploadFiles(files) {
  let last = '';
  for (const f of files) {
    try { last = await imageToDataURL(f); addToMedia(last, f.name); } catch (err) { toast(`${f.name}: ${err.message}`, { error: true }); }
  }
  if (last) { commit(); toast(files.length > 1 ? `${files.length} images added to your library` : 'Image added to your library'); }
  return last;
}

function pickFiles(multiple = true) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'image/*', multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

function mediaTile(img, { onPick, onRemove } = {}) {
  return el('div', { class: 'media-tile' },
    el('button', { type: 'button', class: 'media-tile__img', title: onPick ? `Use ${img.name}` : img.name, style: `background-image:url("${String(siteAsset(img.src)).replace(/["\\]/g, encodeURIComponent)}")`, onclick: () => onPick?.(img.src) }),
    el('span', { class: 'media-tile__name' }, img.name),
    onRemove ? el('button', { type: 'button', class: 'media-tile__rm', title: 'Remove from library', onclick: onRemove }, ico('x')) : null);
}

async function mediaGrids(container, { onPick } = {}) {
  const mine = siteImages();
  container.replaceChildren(
    el('p', { class: 'p-sub' }, `Your images (${mine.length})`),
    mine.length ? el('div', { class: 'media-grid' }, mine.map((img) => mediaTile(img, { onPick,
      onRemove: img.uploaded && !onPick ? () => {
        const ref = img.id && JSON.stringify(state.doc.posts || []).includes(`media:${img.id}`);
        if (ref) { toast('This image is used inside a blog post. Remove it from the post first.', { error: true }); return; }
        state.doc.media = state.doc.media.filter((m) => m.src !== img.src); commit(); renderPanel();
      } : null })))
      : el('p', { class: 'p-hint' }, 'Upload photos of your work, team or logo to reuse them anywhere.'),
    el('p', { class: 'p-sub' }, 'Built-in images'),
    el('div', { class: 'media-grid' }, (await loadLibrary()).map((img) => mediaTile(img, { onPick }))));
}

function panelMedia(box) {
  box.append(panelHead('Images', 'image', el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: async () => { await uploadFiles(await pickFiles()); renderPanel(); } }, ico('upload'), 'Upload')));
  const body = el('div', { class: 'p-body' }, el('p', { class: 'p-hint' }, 'To place an image, select a section and press Library on any image setting. Uploads are resized automatically and saved to your site when you publish.'));
  const grids = el('div');
  body.append(grids);
  box.append(body);
  mediaGrids(grids);
}

function openMediaPicker(onPick) {
  const grids = el('div');
  const pick = (src) => { closeModal(); onPick(src); };
  openModal('Choose an image', el('div', { class: 'picker' },
    el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: async () => { const src = await uploadFiles(await pickFiles(false)); if (src) pick(src); } }, ico('upload'), 'Upload a new image'),
    grids));
  mediaGrids(grids, { onPick: pick });
}

// ---------------------------------------------------------------------------
// History: saved versions (this browser), cloud drafts and published versions
async function addVersion(name) {
  await versions.add({ id: uid('v'), name, savedAt: Date.now(), json: JSON.stringify(state.doc), site: SITE_KEY });
  const all = await versions.list();
  await Promise.all(all.slice(40).map((v) => versions.del(v.id)));
}

function restoreDoc(doc, message) {
  if (!doc?.pages?.length || !doc.site) { toast('That version could not be read.', { error: true }); return; }
  try { state.doc = migrate(doc); } catch (err) { toast(err.message, { error: true }); return; }
  state.page = 0;
  state.sel = null;
  commit();
  refreshAll();
  toast(message, { action: 'Undo', onAction: undo });
}

const when = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function histRow(title, date, actions) {
  return el('div', { class: 'hist-row' },
    el('div', { class: 'hist-row__txt' }, el('strong', {}, title), el('small', {}, when(date))),
    el('div', { class: 'hist-row__actions' }, actions.map(([label, fn, cls]) => el('button', { type: 'button', class: `ed-btn ed-btn--sm${cls ? ` ${cls}` : ''}`, onclick: fn }, label))));
}

function panelHistory(box) {
  box.append(panelHead('History', 'history'));
  const body = el('div', { class: 'p-body' });

  body.append(el('p', { class: 'p-sub' }, 'Saved versions'), el('p', { class: 'p-hint' }, 'Snapshots kept in this browser. One is saved automatically every time you publish.'),
    el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: async () => {
      const name = prompt('Name this version', `Version ${when(Date.now())}`);
      if (name === null) return;
      try { await addVersion(name.trim() || 'Untitled version'); toast('Version saved'); renderPanel(); } catch { toast('Could not save a version in this browser.', { error: true }); }
    } }, ico('bookmark'), 'Save current version'));
  const local = el('div', { class: 'hist' }, el('p', { class: 'p-hint' }, 'Loading…'));
  body.append(local);
  versions.list().then((all) => all.filter((v) => !v.site || v.site === SITE_KEY)).then((vs) => local.replaceChildren(...(vs.length ? vs.map((v) => histRow(v.name, v.savedAt, [
    ['Restore', () => confirm(`Restore “${v.name}”? Your current work can be brought back with Undo.`) && restoreDoc(JSON.parse(v.json), `Restored “${v.name}”`)],
    ['Delete', async () => { await versions.del(v.id); renderPanel(); }, 'ed-btn--danger'],
  ])) : [el('p', { class: 'p-hint' }, 'No saved versions yet.')]))).catch(() => local.replaceChildren(el('p', { class: 'p-hint' }, 'Saved versions are not available in this browser.')));

  body.append(el('p', { class: 'p-sub' }, 'Cloud draft'), el('p', { class: 'p-hint' }, 'Save your unpublished work to GitHub and pick it up on another computer. Drafts live on a separate branch and never change the live site.'),
    el('div', { class: 'f-row' },
      el('button', { type: 'button', class: 'ed-btn', onclick: async (e) => {
        const cfg = await needGH('Cloud drafts are stored in your GitHub repository.');
        if (!cfg) return;
        const b = e.currentTarget; b.disabled = true;
        try { flushCommit(); await saveCloudDraft(cfg, state.doc); toast('Draft saved to the cloud'); } catch (err) { toast(err.message, { error: true }); } finally { b.disabled = false; }
      } }, ico('upload'), 'Save'),
      el('button', { type: 'button', class: 'ed-btn', onclick: async (e) => {
        const cfg = await needGH('Cloud drafts are stored in your GitHub repository.');
        if (!cfg) return;
        const b = e.currentTarget; b.disabled = true;
        try {
          const d = await loadCloudDraft(cfg);
          if (!d) toast('No cloud draft saved yet.');
          else if (confirm(`Load the cloud draft saved ${when(d.savedAt)}? Your current work can be brought back with Undo.`)) restoreDoc(d.doc, 'Cloud draft loaded');
        } catch (err) { toast(err.message, { error: true }); } finally { b.disabled = false; }
      } }, ico('download'), 'Load')));

  body.append(el('p', { class: 'p-sub' }, 'Published versions'));
  const pub = el('div', { class: 'hist' });
  const loadPublished = async (cfg) => {
    pub.replaceChildren(el('p', { class: 'p-hint' }, 'Loading…'));
    try {
      const list = await listPublishedVersions(cfg);
      pub.replaceChildren(...(list.length ? list.map((c) => histRow(c.message, c.date, [['Open', async () => {
        if (!confirm('Load this published version into the editor? Nothing changes on the live site until you publish.')) return;
        try { restoreDoc(await readPublishedVersion(cfg, c.sha), 'Published version loaded — publish to make it live again'); } catch (err) { toast(err.message, { error: true }); }
      }]])) : [el('p', { class: 'p-hint' }, 'No published versions found.')]));
    } catch (err) { pub.replaceChildren(el('p', { class: 'p-hint' }, err.message)); }
  };
  const cfg = currentGH();
  if (cfg) loadPublished(cfg);
  else pub.append(el('button', { type: 'button', class: 'ed-btn ed-btn--block', onclick: async () => { const c = await needGH('Published versions are read from your GitHub repository.'); if (c) loadPublished(c); } }, ico('github'), 'Show published versions'));
  body.append(pub);
  box.append(body);
}

// ---------------------------------------------------------------------------
// Checkup: the site's own rules (audit.js in the site repo) for problems to
// fix before publishing. Errors block publishing; warnings and tips don't.
const LEVEL_LABEL = { error: 'Must fix', warning: 'Worth fixing', tip: 'Suggestions' };
let checks = [];
let checkTimer = 0;

function runChecks() {
  if (!has('audit')) return [];
  try { checks = theme.audit(state.doc); } catch (err) { console.error(err); checks = []; }
  return checks;
}

// Without the site's checkup (older theme), only content errors block publishing.
function publishChecks() {
  return has('audit') ? runChecks() : validate(state.doc).map((message) => ({ level: 'error', code: 'invalid', message, where: { kind: 'site' } }));
}

function refreshChecksSoon() { if (has('audit')) { clearTimeout(checkTimer); checkTimer = setTimeout(refreshChecks, 600); } }
function refreshChecks() {
  if (!has('audit')) return;
  runChecks();
  const n = checks.filter((c) => c.level !== 'tip').length;
  const badge = $('.ed-rail [data-tab="checkup"] .ed-rail__badge');
  if (badge) {
    badge.hidden = !n;
    badge.textContent = String(n);
    badge.classList.toggle('is-err', checks.some((c) => c.level === 'error'));
  }
  markSamples();
  if (state.tab === 'checkup') renderPanel();
}

// Underline leftover sample text on the canvas so it is easy to spot.
function markSamples() {
  const d = cdoc();
  if (!d?.getElementById('app')) return;
  $$('.ed-sample', d).forEach((n) => { n.classList.remove('ed-sample'); n.removeAttribute('title'); });
  if (state.post) return;
  for (const c of checks) {
    if (c.code !== 'sample-text' || c.where.page !== state.page) continue;
    const sec = d.querySelector(`[data-section-id="${CSS.escape(c.where.section)}"]`);
    for (const f of c.where.fields || []) {
      const n = sec?.querySelector(`[data-edit="${CSS.escape(f)}"]`);
      if (n) { n.classList.add('ed-sample'); n.title = 'Sample text: replace it with your own words'; }
    }
  }
}

function checkList(items) {
  return el('ul', { class: 'checks' }, items.map((c) => el('li', { class: `check check--${c.level}` },
    el('span', { class: 'check__icon' }, ico(c.level === 'tip' ? 'bulb' : 'alert')),
    el('span', { class: 'check__msg' }, c.message),
    el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: () => showProblem(c) }, 'Show me'))));
}

function panelCheckup(box) {
  box.append(panelHead('Checkup', 'check-circle', el('button', { type: 'button', class: 'ed-btn ed-btn--sm', onclick: () => { flushCommit(); refreshChecks(); renderPanel(); } }, ico('refresh'), 'Check again')));
  const body = el('div', { class: 'p-body' });
  const list = runChecks();
  if (!list.length) {
    body.append(el('div', { class: 'empty' }, el('span', { class: 'empty__icon' }, ico('check-circle')), el('h3', {}, 'All clear'), el('p', {}, 'No problems found on any page, post or setting.')));
  } else {
    body.append(el('p', { class: 'p-hint' }, 'Every page, post and setting is checked as you work. Problems under “Must fix” stop publishing until they are fixed.'));
    for (const level of ['error', 'warning', 'tip']) {
      const items = list.filter((c) => c.level === level);
      if (items.length) body.append(el('p', { class: 'p-sub' }, `${LEVEL_LABEL[level]} (${items.length})`), checkList(items));
    }
  }
  box.append(body);
}

// Takes the editor to the page, section, post or setting a problem is about.
function showProblem(c) {
  const w = c.where || {};
  closeModal();
  if (w.kind === 'post' && findPost(w.post)) { openPost(w.post); focusField('#panel', w.field); return; }
  if (w.kind === 'page' && state.doc.pages[w.page]) {
    if (w.page !== state.page || state.post) goToPage(w.page);
    if (w.section && findSection(w.section)) {
      const item = String(w.field || '').match(/^(.+?)\.(\d+)(?:\.|$)/);
      if (item) state.open.add(`${w.section}:${item[1]}.${item[2]}`);
      select(w.section, { scroll: true });
      setTimeout(() => scrollToSection(w.section, true), 40);
      focusField('#inspector', w.field);
    } else {
      setTab('pages');
      focusField('#panel', w.field);
    }
    return;
  }
  if (c.code === 'invalid') { setTab(/^Post/.test(c.message) ? 'blog' : /redirect/i.test(c.message) ? 'site' : 'pages'); return; }
  if (['headerCta', 'tagline', 'footerText'].includes(w.field)) { select('__header', { scroll: true }); focusField('#inspector', w.field); return; }
  if (w.field === 'theme') { setTab('theme'); return; }
  setTab('site');
  if (w.field === 'redirects') { setTimeout(() => $('#panel .redirect-add')?.scrollIntoView({ block: 'center' }), 40); return; }
  focusField('#panel', w.field);
}

function focusField(root, field) {
  if (!field) return;
  setTimeout(() => {
    const n = $(`${root} [data-path="${CSS.escape(field)}"]`) || $(`${root} [data-path^="${CSS.escape(`${field}.`)}"]`);
    if (!n) return;
    n.scrollIntoView({ block: 'center' });
    n.focus({ preventScroll: true });
    n.classList.add('ed-flash-field');
    setTimeout(() => n.classList.remove('ed-flash-field'), 1600);
  }, 60);
}

// ---------------------------------------------------------------------------
// Jump to anything (Ctrl+K): pages, sections, posts, panels, settings and
// common actions, found by typing a few letters.
const PANELS = [['add', 'Add a section', 'plus'], ['layers', 'Layers', 'layers'], ['pages', 'Pages', 'file'], ['blog', 'Blog', 'pen'],
  ['media', 'Images', 'image'], ['theme', 'Design', 'droplet'], ['site', 'Settings', 'sliders'], ['history', 'History', 'history'],
  ['checkup', 'Checkup', 'check-circle'], ['help', 'Help', 'help']];
// [label, extra search words, panel, subheading in that panel, needed site feature]
const SETTING_JUMPS = [
  ['Business details', 'name email phone address location contact form endpoint formspree', 'site', 'Business'],
  ['Business hours', 'open closed times schedule opening', 'site', 'Business hours', 'hours'],
  ['Call button', 'phone text sms call now mobile', 'site', 'Call button', 'call-button'],
  ['Review page', 'google reviews link', 'site', 'Business', 'reviews'],
  ['Visitor stats', 'analytics cloudflare goatcounter traffic', 'site', 'Visitor stats', 'analytics'],
  ['Announcement bar', 'banner notice message top holiday sale dates', 'site', 'Announcement bar'],
  ['Social links', 'facebook instagram linkedin youtube x twitter', 'site', 'Social links'],
  ['Search engines', 'google bing verification seo', 'site', 'Search engines', 'verification'],
  ['Share image and tab icon', 'favicon branding social preview', 'site', 'Branding & sharing'],
  ['Redirects', 'old address moved page forward', 'site', 'Redirects', 'redirects'],
  ['Page not found', '404 error missing', 'site', 'Page not found', 'not-found'],
  ['Editor login', 'sign in cloudflare access google email security', 'site', 'Editor login'],
  ['Backup and restore', 'download json restore discard draft', 'site', 'Backup'],
  ['Color themes', 'design palette preset look', 'theme', 'Color themes'],
  ['Colors', 'design brand primary accent background', 'theme', 'Colors'],
  ['Fonts', 'typography headings body text', 'theme', 'Typography'],
];

const strip = (v) => String(v || '').replace(/[*_`#[\]]/g, '').replace(/\(([^)]*)\)/g, '').trim();

function paletteItems() {
  const items = [];
  const add = (group, label, iconName, run, { hint = '', words = '' } = {}) =>
    items.push({ group, label, icon: iconName, run, hint, text: `${label} ${hint} ${words}`.toLowerCase() });
  const actions = [
    ['Publish', 'send', () => $('#publish').click(), 'make it live'],
    ['Preview in a new tab', 'eye', () => $('#preview').click(), 'view draft'],
    ['New page', 'plus', openAddPage, 'add page template'],
    ['New blog post', 'pen', () => newPost('post'), 'write article'],
    ['New blurb', 'sparkle', () => newPost('blurb'), 'short note link'],
    ['Edit header & footer', 'layout', () => select('__header', { scroll: true }), 'menu logo navigation'],
    ['Find & replace', 'search', openFindReplace, 'change words everywhere'],
    ['Undo', 'undo', undo, ''],
    ['Redo', 'redo', redo, ''],
    ['Phone-size preview', 'smartphone', () => setDevice('mobile'), 'mobile device'],
    ['Computer-size preview', 'monitor', () => setDevice('desktop'), 'desktop device'],
    ['Download a backup', 'download', downloadJSON, 'save json'],
    ['Open the live site', 'external', () => window.open(`${SITE}/`, '_blank', 'noopener'), 'view website'],
  ];
  for (const [label, iconName, run, words] of actions) add('Actions', label, iconName, run, { words });
  state.doc.pages.forEach((p, i) => add('Pages', p.title || 'Untitled page', 'file', () => goToPage(i),
    { hint: i === 0 ? 'Home page' : `${pageHref(p, i)}${p.draft ? ' · not on the website yet' : ''}` }));
  for (const [tab, label, iconName] of PANELS) if (tab !== 'checkup' || has('audit')) add('Panels', label, iconName, () => setTab(tab), { hint: 'Panel' });
  for (const [label, words, tab, heading, feature] of SETTING_JUMPS) {
    if (!feature || has(feature)) add('Settings', label, tab === 'theme' ? 'droplet' : 'sliders', () => openSetting(tab, heading), { hint: tab === 'theme' ? 'Design' : 'Settings', words });
  }
  state.doc.pages.forEach((p, i) => p.sections.forEach((sec) => {
    const b = BLOCKS[sec.type];
    if (!b) return;
    add('Sections', strip(sec.label || sectionSummary(sec)) || b.label, b.icon || 'layout', () => goToSection(i, sec.id),
      { hint: `${b.label} on ${p.title}`, words: strip(sec.data?.eyebrow) });
  }));
  (state.doc.posts || []).forEach((p) => add('Blog', postTitle(p) || 'Untitled', p.kind === 'blurb' ? 'sparkle' : 'pen', () => openPost(p.id),
    { hint: `${p.kind === 'blurb' ? 'Blurb' : 'Post'}${p.date ? ` · ${formatDate(p.date)}` : ''}${p.published === false ? ' · draft' : ''}`, words: p.tags || '' }));
  return items;
}

// Best matches first: the name starts with the words, then a word in the name
// does, then the words appear anywhere (name, details or extra search words).
// Results stay together by kind, the kind with the best match first.
function paletteMatches(items, query, limit = 60) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.filter((it) => ['Actions', 'Pages', 'Panels'].includes(it.group));
  const q = words.join(' ');
  const hits = items.map((it, n) => {
    if (!words.every((w) => it.text.includes(w))) return null;
    const name = it.label.toLowerCase();
    const score = name.startsWith(q) ? 0 : name.split(/[\s\-–—&/]+/).some((w) => w.startsWith(words[0])) ? 1 : name.includes(q) ? 2 : 3;
    return { it, n, score };
  }).filter(Boolean).sort((a, b) => a.score - b.score || a.n - b.n).slice(0, limit);
  const rank = new Map();
  hits.forEach((h, i) => { if (!rank.has(h.it.group)) rank.set(h.it.group, i); });
  return hits.sort((a, b) => rank.get(a.it.group) - rank.get(b.it.group)).map((h) => h.it);
}

function goToSection(i, id) {
  if (i !== state.page || state.post) goToPage(i);
  select(id, { scroll: true });
  setTimeout(() => scrollToSection(id, true), 40);
}

function openSetting(tab, heading) {
  setTab(tab);
  setTimeout(() => {
    const h = $$('#panel .p-sub').find((n) => n.textContent === heading);
    if (!h) return;
    h.scrollIntoView({ block: 'start' });
    h.classList.add('ed-flash-field');
    setTimeout(() => h.classList.remove('ed-flash-field'), 1600);
  }, 40);
}

function openPalette() {
  flushCommit();
  const items = paletteItems();
  let shown = [];
  let active = 0;
  const input = el('input', { class: 'in palette__in', type: 'search', placeholder: 'Search pages, sections, posts, settings…', autocomplete: 'off', 'aria-label': 'Jump to', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list' });
  const list = el('div', { class: 'palette__list', id: 'palette-list', role: 'listbox' });
  const run = (it) => { closeModal(); it.run(); };
  const mark = () => {
    list.querySelectorAll('.palette__item').forEach((b, n) => { b.classList.toggle('is-active', n === active); b.setAttribute('aria-selected', String(n === active)); });
    list.querySelector('.palette__item.is-active')?.scrollIntoView({ block: 'nearest' });
  };
  const paint = () => {
    shown = paletteMatches(items, input.value);
    active = 0;
    let group = '';
    const rows = [];
    shown.forEach((it, n) => {
      if (it.group !== group) { group = it.group; rows.push(el('p', { class: 'palette__group' }, group)); }
      rows.push(el('button', { type: 'button', class: 'palette__item', role: 'option', onclick: () => run(it), onmousemove: () => { if (active !== n) { active = n; mark(); } } },
        ico(it.icon), el('span', { class: 'palette__txt' }, el('strong', {}, it.label), it.hint ? el('small', {}, it.hint) : null)));
    });
    list.replaceChildren(...(rows.length ? rows : [el('p', { class: 'palette__none' }, `Nothing found for “${input.value.trim()}”.`)]));
    hydrateIcons(list);
    mark();
  };
  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; mark(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) run(shown[active]);
    } else if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
  });
  openModal('Jump to', el('div', { class: 'palette' }, el('div', { class: 'palette__search' }, ico('search'), input), list,
    el('p', { class: 'palette__foot' }, el('kbd', {}, '↑'), el('kbd', {}, '↓'), ' to move · ', el('kbd', {}, 'Enter'), ' to open · ', el('kbd', {}, 'Esc'), ' to close')));
  paint();
  setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------------------
// Find & replace across all pages and site settings
const NON_TEXT = new Set(['id', 'type', 'icon', 'image', 'bgImage', 'logo', 'logoIcon', 'panelIcon', 'favicon', 'shareImage', 'href', 'link', 'src', 'bg', 'pad',
  'layout', 'side', 'columns', 'style', 'ratio', 'width', 'height', 'align', 'overlay', 'anchor', 'headerStyle', 'formEndpoint', 'slug', 'url', 'kind', 'date', 'show', 'limit', 'size']);

function eachText(fn) {
  (function walk(node, key) {
    if (Array.isArray(node)) node.forEach((n, i) => { if (typeof n === 'string') node[i] = fn(n) ?? n; else walk(n, key); });
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') { if (!NON_TEXT.has(k) && !v.startsWith('data:')) node[k] = fn(v) ?? v; } else walk(v, k);
      }
    }
  })({ site: state.doc.site, pages: state.doc.pages, posts: state.doc.posts }, '');
}

function openFindReplace() {
  const find = el('input', { class: 'in', placeholder: 'Find…' });
  const repl = el('input', { class: 'in', placeholder: 'Replace with…' });
  const matchCase = el('input', { type: 'checkbox' });
  const info = el('p', { class: 'p-hint', style: 'margin:0' }, 'Type something to search all pages.');
  const go = el('button', { type: 'button', class: 'ed-btn ed-btn--primary', disabled: true }, ico('replace'), 'Replace all');
  const rx = () => find.value && new RegExp(find.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase.checked ? 'g' : 'gi');
  const count = () => {
    const r = rx();
    let n = 0;
    if (r) eachText((v) => { n += (v.match(r) || []).length; });
    info.textContent = !find.value ? 'Type something to search all pages.' : `${n} match${n === 1 ? '' : 'es'} found`;
    go.disabled = !n;
  };
  find.addEventListener('input', count);
  matchCase.addEventListener('change', count);
  go.addEventListener('click', () => {
    const r = rx();
    if (!r) return;
    let n = 0;
    eachText((v) => v.replace(r, () => { n += 1; return repl.value; }));
    commit(); refreshAll(); count();
    toast(`Replaced ${n} match${n === 1 ? '' : 'es'}`, { action: 'Undo', onAction: undo });
  });
  openModal('Find & replace', el('div', {},
    el('div', { class: 'f' }, el('label', {}, 'Find'), find),
    el('div', { class: 'f' }, el('label', {}, 'Replace with'), repl),
    el('div', { class: 'f' }, el('label', { class: 'switch' }, 'Match case', matchCase)),
    info,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'ed-btn', onclick: closeModal }, 'Close'), go)));
  setTimeout(() => find.focus(), 50);
}

// ---------------------------------------------------------------------------
// Modal, toasts, top bar
function openModal(title, content) {
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(content);
  $('#modal').hidden = false;
  hydrateIcons($('#modal'));
}
function closeModal() { $('#modal').hidden = true; }
$$('#modal [data-close]').forEach((n) => n.addEventListener('click', closeModal));

function toast(text, { action, onAction, error = false, duration } = {}) {
  const t = el('div', { class: `toast${error ? ' is-err' : ''}` }, text);
  if (action) t.append(el('button', { type: 'button', onclick: () => { onAction(); t.remove(); } }, action));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), duration || (action ? 6000 : 3200));
}

function updateTopbar() {
  $('#undo').disabled = !state.history.length;
  $('#redo').disabled = !state.future.length;
  const sel = $('#page-select');
  sel.replaceChildren(...state.doc.pages.map((p, i) => el('option', { value: String(i), selected: i === state.page }, `${p.title}${i > 0 && p.draft ? ' (unpublished)' : ''}`)));
  const dirty = state.snap !== state.published;
  const st = $('#status');
  st.textContent = dirty ? 'Draft saved · not published' : 'Published';
  st.classList.toggle('is-dirty', dirty);
}

function setDevice(d) {
  state.device = d;
  $('#frame-wrap').dataset.device = d;
  // The canvas can be narrower than a computer screen, so phones-only things follow the chosen size.
  if (cdoc()?.body) cdoc().body.dataset.device = d;
  $$('#device-toggle button').forEach((b) => b.classList.toggle('is-on', b.dataset.device === d));
}

function refreshAll() {
  if (state.post && !findPost(state.post)) state.post = null;
  applyTheme();
  renderCanvas();
  renderPanel();
  renderInspector();
  updateTopbar();
}

function onGlobalKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushCommit(); saveDraft(); toast('Draft saved'); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); e.target.blur?.(); openPalette(); return; }
  if (inField) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  // With an element selected, Delete, Ctrl+D and Escape act on the element.
  else if (state.el != null && state.sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); elementTool('el-delete', state.sel, state.el); }
  else if (state.el != null && state.sel && mod && e.key.toLowerCase() === 'd') { e.preventDefault(); elementTool('el-copy', state.sel, state.el); }
  else if (state.el != null && state.sel && e.key === 'Escape' && $('#modal').hidden) { state.el = null; renderInspector(); decorateSelection(); }
  else if (mod && e.key.toLowerCase() === 'd' && state.sel && !isChrome(state.sel)) { e.preventDefault(); runTool('duplicate', state.sel); }
  else if (mod && e.key.toLowerCase() === 'c' && state.sel && !isChrome(state.sel) && !String(e.target.ownerDocument?.getSelection?.() || '')) { e.preventDefault(); copySection(state.sel); }
  else if (mod && e.key.toLowerCase() === 'v' && getClipboard()) { e.preventDefault(); pasteSection(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel && !isChrome(state.sel)) { e.preventDefault(); runTool('delete', state.sel); }
  else if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else select(null); }
}

// ---------------------------------------------------------------------------
// Boot
async function boot() {
  hydrateIcons();
  $$('a[data-site-link]').forEach((a) => { a.href = `${SITE}/`; });
  let published = null;
  let publishedSha = '';
  try { ({ doc: published, sha: publishedSha } = await fetchPublished()); } catch (e) { toast(e.message, { error: true }); }
  let draft = null;
  let known = [];
  let saved = null;
  let aside = null;
  try {
    saved = await kv.get('draft');
    aside = await kv.get('draft-aside');
    known = (await kv.get('known-bases')) || [];
  } catch { /* IndexedDB unavailable */ }
  // A draft for a different site (the editor was pointed elsewhere) is kept aside, not loaded.
  if (saved?.json && saved.site && saved.site !== SITE_KEY) {
    await kv.set('draft-aside', { ...saved, reason: 'site' }).catch(() => {});
    toast(`An unpublished draft for another site (${saved.site.split('|')[0]}) was set aside.`, { duration: 10000 });
    saved = null;
  }
  if (saved?.json) draft = { doc: JSON.parse(saved.json), base: saved.base || '' };
  if (!draft) { try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore */ } }
  let loadError = '';
  const safeMigrate = (d) => { try { return d ? migrate(d) : null; } catch (err) { loadError = err.message; return null; } };
  published = safeMigrate(published);
  if (!published && loadError) toast(loadError, { error: true });
  const fromDraft = safeMigrate(draft?.doc);
  if (draft?.doc && !fromDraft) {
    // Made by a newer version of the site: keep it instead of overwriting it on the first edit.
    await kv.set('draft-aside', { savedAt: Date.now(), json: JSON.stringify(draft.doc), base: draft.base, site: SITE_KEY, reason: 'newer' }).catch(() => {});
    toast('Your unpublished draft was made with a newer version of your site and can’t be opened yet. It was kept safe and will be offered again once the site has updated.', { error: true, duration: 15000 });
  }
  state.doc = fromDraft || published;
  if (!state.doc) { showFatal(`Your site’s content couldn’t be loaded. ${loadError}`); return; }
  state.published = published ? JSON.stringify(published) : '';
  state.snap = JSON.stringify(state.doc);
  // A draft remembers which live version it started from (older drafts don't know).
  if (fromDraft) state.base = draft.base || '';
  else await setBase(publishedSha);
  const changedElsewhere = draft?.base && publishedSha && publishedSha !== draft.base && !known.includes(publishedSha);
  restoreUrl();

  accessIdentity().then((id) => { state.access = id; showAccount(id); if (state.tab === 'site') renderPanel(); });
  await initCanvas();
  const checkupTab = $('.ed-rail [data-tab="checkup"]');
  if (checkupTab) checkupTab.hidden = !has('audit');
  refreshAll();
  refreshChecks();
  if (changedElsewhere && state.snap !== state.published) {
    toast('Your site was changed somewhere else after you started this draft. Publishing the draft would replace those changes.', { action: 'Load live version', onAction: resetToPublished, duration: 20000 });
  } else if (draft?.doc && state.snap !== state.published) toast('Restored your unpublished draft', { action: 'Discard', onAction: resetToPublished });
  // A draft set aside earlier (newer site version) can be opened once this site understands it.
  if (aside?.json && aside.reason === 'newer' && (aside.json !== saved?.json)) {
    let ok = null;
    try { ok = migrate(JSON.parse(aside.json)); } catch { ok = null; }
    if (ok) {
      toast(`A draft from ${when(aside.savedAt)} was kept safe earlier. Open it?`, { duration: 20000, action: 'Open', onAction: () => { kv.del('draft-aside').catch(() => {}); restoreDoc(JSON.parse(aside.json), 'Draft opened'); } });
    }
  }
  syncUrl();

  $$('.ed-rail button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('#device-toggle button').forEach((b) => b.addEventListener('click', () => setDevice(b.dataset.device)));
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#page-select').addEventListener('change', (e) => goToPage(+e.target.value));
  $('#publish').addEventListener('click', openPublish);
  $('#preview').addEventListener('click', async () => { flushCommit(); await saveDraft(); const post = state.post && findPost(state.post);
    window.open(`preview.html?path=${encodeURIComponent(post ? `/${POSTS_BASE}/${post.slug}/` : pageHref(page(), state.page))}`, '_blank', 'noopener'); });
  $('#find').addEventListener('click', openFindReplace);
  $('#jump')?.addEventListener('click', openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $$('#jump kbd').forEach((k) => { k.textContent = '⌘K'; });
  document.addEventListener('keydown', onGlobalKey);
  addEventListener('beforeunload', () => flushCommit());
}

boot();
