// Turns formatted text copied from Word, Google Docs or a web page into the
// simple markdown the blog uses (## headings, **bold**, *italic*, [links](…),
// lists, > quotes, `code`). Runs in the browser on the clipboard's HTML. The
// HTML is parsed inside a <template>, whose contents are inert by definition
// (nothing loads, no event handler can run), and is only read, never inserted.

const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'TEMPLATE', 'svg', 'SVG', 'IFRAME', 'OBJECT', 'NOSCRIPT']);
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'DL', 'DT', 'DD']);

// Only formatting a word processor really means: Word and Google Docs mark
// everything with spans and inline styles instead of <b> and <i>.
function styleOf(el) {
  const st = el.getAttribute?.('style') || '';
  const weight = (st.match(/font-weight\s*:\s*([\w]+)/i) || [])[1];
  return {
    bold: weight ? weight === 'bold' || Number(weight) >= 600 : null,
    italic: /font-style\s*:\s*italic/i.test(st) ? true : /font-style\s*:\s*normal/i.test(st) ? false : null,
    mono: /font-family\s*:[^;]*(courier|consolas|monospace|menlo|monaco)/i.test(st),
    msoIgnore: /mso-list\s*:\s*ignore/i.test(st),
  };
}

const isWordListPara = (el) => /MsoListParagraph/i.test(el.className || '') || /mso-list\s*:\s*l\d/i.test(el.getAttribute?.('style') || '');

// Removes inline event handlers (onerror=, onload=, …) and javascript: links from every tag before
// the browser parses the markup. The parsed copy is inert anyway; this keeps
// the browser from even seeing a handler (newer Chrome reports them to the
// page's security policy as soon as they are parsed).
const TAG = /<[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
const HANDLER = /([\s/"'])on[a-z][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;
const SCRIPT_URL = /([\s/"'])((?:xlink:)?href|src|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s"'>]*)/gi;
export function stripHandlers(html) {
  return String(html || '').replace(TAG, (tag) => tag.replace(HANDLER, '$1').replace(SCRIPT_URL, '$1'));
}

function safeLink(href) {
  const h = String(href || '').trim();
  return /^(https?:|mailto:|tel:|\/|#)/i.test(h) ? h : '';
}

export function htmlToMarkdown(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = stripHandlers(html);
  const blocks = [];
  let line = '';

  const flush = () => { const t = line.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim(); if (t) blocks.push(t); line = ''; };

  // Inline content of a node as markdown.
  function inline(node, fmt = { bold: false, italic: false, mono: false }) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return '';
    const tag = node.tagName;
    const st = styleOf(node);
    if (st.msoIgnore) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') {
      const src = String(node.getAttribute('src') || '');
      return /^https:\/\//i.test(src) ? `![${(node.getAttribute('alt') || '').replace(/[[\]]/g, '')}](${src})` : '';
    }
    const next = { ...fmt };
    // Google Docs wraps everything in <b style="font-weight:normal">, so styles win over tags.
    if (tag === 'B' || tag === 'STRONG') next.bold = st.bold ?? true;
    else if (st.bold != null) next.bold = st.bold;
    if (tag === 'I' || tag === 'EM') next.italic = st.italic ?? true;
    else if (st.italic != null) next.italic = st.italic;
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || st.mono) next.mono = true;
    let inner = [...node.childNodes].map((c) => inline(c, next)).join('');
    if (tag === 'A') {
      const href = safeLink(node.getAttribute('href'));
      const text = inner.trim();
      return href && text && !/^#/.test(href) ? `[${text.replace(/[[\]]/g, '')}](${href.replace(/\s/g, '%20').replace(/\)/g, '%29')})` : inner;
    }
    if (next.mono && !fmt.mono && inner.trim()) return wrap(inner, '`');
    if (next.bold && !fmt.bold && inner.trim()) inner = wrap(inner, '**');
    if (next.italic && !fmt.italic && inner.trim()) inner = wrap(inner, '*');
    return inner;
  }

  // Keeps spaces outside the markers: "** bold**" would not render.
  function wrap(text, mark) {
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return `${m[1]}${mark}${m[2].replace(/\n+/g, ' ')}${mark}${m[3]}`;
  }

  function block(node) {
    if (node.nodeType === 3) { line += inline(node); return; }
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
    const tag = node.tagName;
    if (styleOf(node).msoIgnore) return;
    if (!BLOCK.has(tag)) {
      // Inline elements may still contain blocks (Google Docs' outer <b>).
      if (node.querySelector?.([...BLOCK].join(','))) { [...node.childNodes].forEach(block); return; }
      line += inline(node);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      flush();
      const level = Math.min(4, Math.max(2, Number(tag[1])));
      const text = inline(node).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      if (text) blocks.push(`${'#'.repeat(level)} ${text}`);
      return;
    }
    if (tag === 'HR') { flush(); blocks.push('---'); return; }
    if (tag === 'PRE') {
      flush();
      const code = node.textContent.replace(/\n$/, '');
      if (code.trim()) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      flush();
      const inner = htmlToMarkdown(node.innerHTML);
      if (inner) blocks.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      flush();
      const items = [];
      let n = 1;
      for (const li of node.children) {
        if (li.tagName !== 'LI') continue;
        const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
        const text = [...li.childNodes].filter((c) => !nested.includes(c)).map((c) => inline(c)).join('').replace(/\s+/g, ' ').trim();
        if (text) items.push(`${tag === 'OL' ? `${n++}.` : '-'} ${text}`);
        for (const sub of nested) items.push(...htmlToMarkdown(sub.outerHTML).split('\n').filter(Boolean));
      }
      if (items.length) blocks.push(items.join('\n'));
      return;
    }
    if (tag === 'TR') {
      flush();
      const cells = [...node.children].map((c) => inline(c).replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (cells.length) blocks.push(cells.join(' | '));
      return;
    }
    if (tag === 'P' && isWordListPara(node)) {
      // Word lists are paragraphs with a hidden bullet or number span.
      flush();
      const marker = [...node.querySelectorAll('span')].find((s) => styleOf(s).msoIgnore)?.textContent.trim() || '';
      const text = inline(node).replace(/\s+/g, ' ').trim();
      if (text) {
        const item = `${/^\d+[.)]$/.test(marker) ? `${parseInt(marker, 10)}.` : '-'} ${text}`;
        const prev = blocks[blocks.length - 1];
        if (prev && /^(- |\d+\. )/.test(prev)) blocks[blocks.length - 1] = `${prev}\n${item}`;
        else blocks.push(item);
      }
      return;
    }
    flush();
    [...node.childNodes].forEach(block);
    flush();
  }

  [...tpl.content.childNodes].forEach(block);
  flush();
  return blocks.join('\n\n').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// True when clipboard HTML carries formatting worth converting, rather than
// plain text wrapped in markup (e.g. from a code editor).
export function hasFormatting(html) {
  return /docs-internal-guid|urn:schemas-microsoft-com:office|class="?Mso|<(h[1-6]|ul|ol|li|strong|b|em|i|blockquote|a\s[^>]*href)[\s>]/i.test(String(html || ''));
}
