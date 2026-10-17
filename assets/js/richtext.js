// The text toolbar shown above rich text while it is being typed on the canvas:
// paragraph or heading, bold, italic, underline, strike-through, links, lists,
// alignment, colour, size and clear formatting.
//
// It lives inside the canvas document (so it can sit right above the text) and
// uses the browser's own editing commands, which handle selections across
// paragraphs. Colours and sizes are applied with a placeholder value first and
// then swapped for the real one, so theme colours can be stored as theme names
// (var(--c-primary)) that follow the theme when it changes.
//
// The site cleans what is saved (cleanHTML), so whatever the browser produces,
// only allowed formatting is kept.

const MARK_COLOR = '#010203';
const MARK_RGB = 'rgb(1, 2, 3)';
const SIZES = [['Small', '0.85em'], ['Normal', ''], ['Large', '1.25em'], ['Larger', '1.5em'], ['Huge', '2em']];
const BLOCKS = [['p', 'Paragraph'], ['h2', 'Heading'], ['h3', 'Subheading'], ['h4', 'Small heading'], ['blockquote', 'Quote']];
const ALIGN = [['justifyLeft', 'Left', 'align-left'], ['justifyCenter', 'Center', 'align-center'], ['justifyRight', 'Right', 'align-right']];

const SVG = (d) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const OWN_ICONS = {
  ol: SVG('<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  unlink: SVG('<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4 8M8 12h3"/><path d="M3 3l18 18"/>'),
  clear: SVG('<path d="M4 7V5h12v2M10 5l-3 14M6 19h4"/><path d="M15 14l5 5M20 14l-5 5"/>'),
};

export function createRichToolbar({ doc, icon, colors, onLink, onChange }) {
  const ic = (name) => OWN_ICONS[name] || icon(name);
  const bar = doc.createElement('div');
  bar.className = 'ed-rt';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Text formatting');
  const btn = (cmd, label, inner, extra = '') => `<button type="button" data-rt="${cmd}" title="${label}" aria-label="${label}"${extra}>${inner}</button>`;
  const menu = (id, items) => `<div class="ed-rt__menu" data-menu="${id}" hidden>${items}</div>`;
  bar.innerHTML = [
    `<span class="ed-rt__group">${btn('menu:block', 'Paragraph or heading', '<span class="ed-rt__block">Paragraph</span>', ' data-wide')}${menu('block', BLOCKS.map(([t, l]) => btn(`block:${t}`, l, `<span class="ed-rt__opt ed-rt__opt--${t}">${l}</span>`)).join(''))}</span>`,
    btn('bold', 'Bold (Ctrl+B)', '<b>B</b>'),
    btn('italic', 'Italic (Ctrl+I)', '<i>I</i>'),
    btn('underline', 'Underline (Ctrl+U)', '<u>U</u>'),
    btn('strikeThrough', 'Strike through', '<s>S</s>'),
    '<i class="ed-rt__sep"></i>',
    btn('link', 'Link (Ctrl+K)', ic('link')),
    btn('unlink', 'Remove link', ic('unlink')),
    '<i class="ed-rt__sep"></i>',
    btn('insertUnorderedList', 'Bulleted list', ic('list')),
    btn('insertOrderedList', 'Numbered list', ic('ol')),
    `<span class="ed-rt__group">${btn('menu:align', 'Alignment', ic('align-left'))}${menu('align', ALIGN.map(([c, l, i]) => btn(c, l, `${ic(i)}<span>${l}</span>`)).join(''))}</span>`,
    '<i class="ed-rt__sep"></i>',
    `<span class="ed-rt__group">${btn('menu:color', 'Text colour', `${ic('droplet')}<i class="ed-rt__swatch"></i>`)}${menu('color',
      `<div class="ed-rt__colors">${colors.map(([name, value, swatch]) => btn(`color:${value}`, name, `<i style="background:${swatch}"></i>`)).join('')}</div>`
      + `<label class="ed-rt__custom">Custom <input type="color" value="#2563eb" data-rt-custom></label>${btn('color:', 'Default colour', '<span>Default colour</span>', ' data-wide')}`)}</span>`,
    `<span class="ed-rt__group">${btn('menu:size', 'Text size', ic('type'))}${menu('size', SIZES.map(([l, v]) => btn(`size:${v}`, l, `<span style="font-size:${v || '1em'}">${l}</span>`)).join(''))}</span>`,
    btn('clear', 'Clear formatting', ic('clear')),
  ].join('');
  doc.body.append(bar);

  let active = null; // the rich text element being edited
  let saved = null; // its last selection, kept while a menu or the colour picker has focus

  const win = doc.defaultView;
  const selection = () => doc.getSelection();
  const inActive = (node) => !!active && !!node && active.contains(node.nodeType === 1 ? node : node.parentNode);
  const closeMenus = () => bar.querySelectorAll('[data-menu]').forEach((m) => { m.hidden = true; });
  const restore = () => {
    if (!active) return;
    if (doc.activeElement !== active) active.focus({ preventScroll: true });
    if (saved) { const s = selection(); s.removeAllRanges(); s.addRange(saved); }
  };
  const changed = () => { if (active) onChange(active); update(); };

  function place() {
    if (!active || bar.hidden) return;
    const r = active.getBoundingClientRect();
    const h = bar.offsetHeight;
    const w = bar.offsetWidth;
    const vw = doc.documentElement.clientWidth;
    // Above the text, clear of the element's own toolbar; below it when there is no room.
    let top = r.top - h - 40;
    if (top < 8) top = r.bottom + 10 + h < win.innerHeight ? r.bottom + 10 : 8;
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(Math.max(8, Math.min(r.left, vw - w - 8)))}px`;
  }

  function update() {
    if (!active) return;
    for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']) {
      let on = false;
      try { on = doc.queryCommandState(cmd); } catch { /* not supported */ }
      bar.querySelector(`[data-rt="${cmd}"]`)?.classList.toggle('is-on', on);
    }
    let block = '';
    try { block = String(doc.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* not supported */ }
    const name = (BLOCKS.find(([t]) => t === block) || BLOCKS[0])[1];
    bar.querySelector('.ed-rt__block').textContent = name;
    const a = linkAt();
    bar.querySelector('[data-rt="unlink"]').hidden = !a;
    bar.querySelector('[data-rt="link"]').classList.toggle('is-on', !!a);
  }

  // The link the selection is in, if any.
  function linkAt() {
    const s = selection();
    const n = s?.anchorNode;
    const a = n && (n.nodeType === 1 ? n : n.parentNode)?.closest?.('a');
    return a && active?.contains(a) ? a : null;
  }

  // Swaps the placeholder colour or size the browser just applied for the real value.
  function swapMarks(prop, value) {
    const marks = prop === 'color'
      ? active.querySelectorAll(`font[color="${MARK_COLOR}"], [style*="${MARK_RGB}"]`)
      : active.querySelectorAll('font[size="7"], [style*="xxx-large"]');
    marks.forEach((n) => {
      // Only spans keep colours and sizes, so a mark on bold text or a paragraph moves into a span inside it.
      let span = n;
      if (n.tagName !== 'SPAN') {
        span = doc.createElement('span');
        span.append(...n.childNodes);
        if (n.tagName === 'FONT') n.replaceWith(span);
        else {
          n.append(span);
          n.style.removeProperty(prop);
          if (!n.getAttribute('style')) n.removeAttribute('style');
        }
      }
      span.style.removeProperty(prop);
      if (value) span.style.setProperty(prop, value);
      // The same setting on spans inside no longer applies.
      span.querySelectorAll('span').forEach((inner) => inner.style.removeProperty(prop));
      if (!span.getAttribute('style')) span.replaceWith(...span.childNodes);
    });
    active.querySelectorAll('span:not([style]), span[style=""]').forEach((s) => s.replaceWith(...s.childNodes));
  }

  function mark(prop, value) {
    restore();
    if (selection().isCollapsed) return;
    doc.execCommand('styleWithCSS', false, true);
    if (prop === 'color') doc.execCommand('foreColor', false, MARK_COLOR);
    else doc.execCommand('fontSize', false, '7');
    doc.execCommand('styleWithCSS', false, false);
    swapMarks(prop, value);
    changed();
  }

  function link() {
    restore();
    // The link picker takes focus away, so remember which text this is for.
    const node = active;
    const a = linkAt();
    if (a) { const r = doc.createRange(); r.selectNodeContents(a); selection().removeAllRanges(); selection().addRange(r); }
    const range = selection().rangeCount ? selection().getRangeAt(0).cloneRange() : null;
    const current = a ? a.getAttribute('href') || '' : '';
    onLink(current, (href) => {
      if (!node?.isConnected) return;
      node.focus({ preventScroll: true });
      if (range) { selection().removeAllRanges(); selection().addRange(range); }
      const done = () => { onChange(node); update(); };
      if (!href) { doc.execCommand('unlink'); done(); return; }
      if (selection().isCollapsed) {
        const t = doc.createElement('a');
        t.href = href;
        t.textContent = href.replace(/^(mailto:|tel:)/, '');
        doc.execCommand('insertHTML', false, t.outerHTML);
      } else doc.execCommand('createLink', false, href);
      done();
    });
  }

  function run(cmd) {
    if (cmd.startsWith('menu:')) {
      const m = bar.querySelector(`[data-menu="${cmd.slice(5)}"]`);
      const open = m.hidden;
      closeMenus();
      m.hidden = !open;
      return;
    }
    closeMenus();
    if (cmd.startsWith('color:')) { mark('color', cmd.slice(6)); return; }
    if (cmd.startsWith('size:')) { mark('font-size', cmd.slice(5)); return; }
    restore();
    if (cmd.startsWith('block:')) {
      const tag = cmd.slice(6);
      let cur = '';
      try { cur = String(doc.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* not supported */ }
      doc.execCommand('formatBlock', false, `<${cur === tag && tag !== 'p' ? 'p' : tag}>`);
    } else if (cmd === 'link') { link(); return; } else if (cmd === 'clear') {
      doc.execCommand('removeFormat');
      doc.execCommand('unlink');
    } else doc.execCommand(cmd);
    changed();
  }

  bar.addEventListener('mousedown', (e) => {
    // Keep the text selection: only the colour picker may take focus.
    if (!e.target.closest('input')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rt]');
    if (b) run(b.dataset.rt);
  });
  const custom = bar.querySelector('[data-rt-custom]');
  custom.addEventListener('change', () => { closeMenus(); mark('color', custom.value); });

  doc.addEventListener('selectionchange', () => {
    const s = selection();
    if (active && s.rangeCount && inActive(s.anchorNode)) { saved = s.getRangeAt(0).cloneRange(); update(); }
  });
  win.addEventListener('scroll', place, { passive: true });
  win.addEventListener('resize', place);

  return {
    el: bar,
    // Shows the toolbar for a rich text element (or hides it with null).
    attach(node) {
      if (node === active) { place(); return; }
      active = node;
      saved = null;
      closeMenus();
      bar.hidden = !node;
      if (node) { update(); place(); }
    },
    get active() { return active; },
    contains: (node) => bar.contains(node),
    link: () => { if (active) link(); },
    place,
  };
}
