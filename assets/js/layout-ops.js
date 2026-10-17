// Changes to a layout section's rows, columns and elements. Pure functions on
// the section data, so they can be tested without a browser.
//
// A piece is addressed by its path in the section data, like the site's
// renderer writes it in data-node: rows.0, rows.0.cols.1, rows.0.cols.1.els.2,
// and rows.0.cols.1.els.2.els.0 for an element inside a box.

const LIST_OF = { row: 'rows', col: 'cols', el: 'els' };
const KIND_OF = { rows: 'row', cols: 'col', els: 'el' };

export const kindOf = (path) => KIND_OF[String(path).split('.').slice(-2, -1)[0]] || null;

// The list a piece sits in and its position: rows.0.cols.1 → { list: 'rows.0.cols', index: 1 }.
export function locate(path) {
  const parts = String(path).split('.');
  return { list: parts.slice(0, -1).join('.'), index: Number(parts[parts.length - 1]) };
}

export const parentOf = (path) => { const parts = String(path).split('.'); return parts.length > 2 ? parts.slice(0, -2).join('.') : null; };

export function getAt(data, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
}

function listAt(data, listPath, create = false) {
  const parts = String(listPath).split('.');
  const key = parts.pop();
  const owner = parts.length ? getAt(data, parts.join('.')) : data;
  if (!owner || typeof owner !== 'object') return null;
  if (!Array.isArray(owner[key])) { if (!create) return null; owner[key] = []; }
  return owner[key];
}

// Every path that exists in the section: for checking a selection after undo.
export const exists = (data, path) => !!path && getAt(data, path) != null && kindOf(path) != null;

export function removeAt(data, path) {
  const { list, index } = locate(path);
  const arr = listAt(data, list);
  return arr && arr[index] !== undefined ? arr.splice(index, 1)[0] : undefined;
}

export function insertAt(data, listPath, index, node) {
  const arr = listAt(data, listPath, true);
  const i = Math.max(0, Math.min(index ?? arr.length, arr.length));
  arr.splice(i, 0, node);
  return `${listPath}.${i}`;
}

// Moves a piece to position `index` of another list (in the same or another
// section's data). Returns its new path, or null when the move isn't possible:
// a box can't go inside itself, and pieces only go in lists of their kind.
export function moveTo(fromData, fromPath, toData, toList, index) {
  const kind = kindOf(fromPath);
  if (!kind || KIND_OF[String(toList).split('.').pop()] !== kind) return null;
  if (fromData === toData && (`${toList}.`).startsWith(`${fromPath}.`)) return null;
  const { list, index: from } = locate(fromPath);
  if (fromData === toData && list === toList && (index === from || index === from + 1)) return fromPath;
  const node = removeAt(fromData, fromPath);
  if (node === undefined) return null;
  // Removing it shifts what came after it in the same list, including the target list's own path.
  let target = toList;
  let i = index;
  if (fromData === toData) {
    if (list === toList && from < index) i -= 1;
    target = shiftAfterRemoval(toList, fromPath);
  }
  return insertAt(toData, target, i, node);
}

// A path after the piece at `removed` was taken out of its list.
export function shiftAfterRemoval(path, removed) {
  const { list, index } = locate(removed);
  const prefix = `${list}.`;
  if (!String(path).startsWith(prefix)) return path;
  const rest = String(path).slice(prefix.length).split('.');
  const n = Number(rest[0]);
  if (n > index) rest[0] = String(n - 1);
  return prefix + rest.join('.');
}

// Swaps a piece with the one before (dir -1) or after (dir 1). Returns its new path.
export function moveBy(data, path, dir) {
  const { list, index } = locate(path);
  const arr = listAt(data, list);
  const j = index + dir;
  if (!arr || j < 0 || j >= arr.length) return path;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  return `${list}.${j}`;
}

export function duplicateAt(data, path) {
  const node = getAt(data, path);
  if (node == null) return null;
  const { list, index } = locate(path);
  return insertAt(data, list, index + 1, JSON.parse(JSON.stringify(node)));
}

// Twelfths shared as evenly as possible: 5 columns → 3 3 2 2 2.
export function evenSpans(n) {
  const count = Math.max(1, Math.min(12, n));
  const base = Math.floor(12 / count);
  return Array.from({ length: count }, (_, i) => base + (i < 12 % count ? 1 : 0));
}

// Gives a row these column widths. Extra columns are added empty; when there are
// fewer, the elements of the columns that go are moved into the last one kept.
export function setSpans(row, spans) {
  row.cols = Array.isArray(row.cols) ? row.cols : [];
  while (row.cols.length < spans.length) row.cols.push({ span: 12, els: [] });
  if (row.cols.length > spans.length) {
    const gone = row.cols.splice(spans.length);
    const last = row.cols[spans.length - 1];
    last.els = [...(Array.isArray(last.els) ? last.els : []), ...gone.flatMap((c) => (Array.isArray(c.els) ? c.els : []))];
  }
  row.cols.forEach((c, i) => { c.span = spans[i]; });
  return row;
}

// Adds an empty column after column `at` (or at the end) and shares the width evenly.
export function addColumn(row, at = null) {
  const cols = Array.isArray(row.cols) ? row.cols : (row.cols = []);
  if (cols.length >= 12) return null;
  const i = at == null ? cols.length : at + 1;
  cols.splice(i, 0, { span: 12, els: [] });
  evenSpans(cols.length).forEach((s, j) => { cols[j].span = s; });
  return i;
}

// Moves the line between column i and the next one by `delta` twelfths; both keep at least 1.
export function moveBoundary(row, i, delta) {
  const a = row.cols?.[i];
  const b = row.cols?.[i + 1];
  if (!a || !b) return false;
  const sa = clampSpan(a.span);
  const sb = clampSpan(b.span);
  const d = Math.max(1 - sa, Math.min(sb - 1, Math.round(delta)));
  if (!d) return false;
  a.span = sa + d;
  b.span = sb - d;
  return true;
}

// Removes column i; its width goes to the column before it (or after it, for the first).
export function removeColumn(row, i) {
  const cols = Array.isArray(row?.cols) ? row.cols : [];
  if (!cols[i]) return null;
  const [gone] = cols.splice(i, 1);
  const next = cols[i - 1] || cols[i];
  if (next) next.span = clampSpan(clampSpan(next.span) + clampSpan(gone.span));
  return gone;
}

export const clampSpan = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : 12; };

// Sets one style value for every screen ('design') or for phones ('mobile');
// an empty value removes the setting, and an empty group is removed too.
export function setStyle(node, key, value, screen = 'design') {
  const empty = value === '' || value == null || (typeof value === 'number' && !Number.isFinite(value));
  const group = node[screen] && typeof node[screen] === 'object' ? node[screen] : {};
  if (empty) delete group[key]; else group[key] = value;
  if (Object.keys(group).length) node[screen] = group; else delete node[screen];
  return node;
}

// A short description of an element for lists: its words, or nothing.
export function nodeText(el) {
  if (!el || typeof el !== 'object') return '';
  const raw = el.text || el.label || el.title || el.caption || el.alt || el.html || el.items?.[0]?.text || '';
  const t = String(raw).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;|&#39;/g, "'")
    .replace(/[*_`#>[\]()!]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

// Where a new element goes when one is added with something selected: after a
// selected element, at the end of a selected column or box, or at the end of the
// last column of a selected row (or of the section's last row).
export function addTarget(data, path) {
  const kind = path ? kindOf(path) : null;
  if (kind === 'el') {
    const node = getAt(data, path);
    if (node?.type === 'box') return { list: `${path}.els`, index: Array.isArray(node.els) ? node.els.length : 0 };
    const { list, index } = locate(path);
    return { list, index: index + 1 };
  }
  if (kind === 'col') return { list: `${path}.els`, index: (getAt(data, `${path}.els`) || []).length };
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const r = kind === 'row' ? locate(path).index : rows.length - 1;
  if (r < 0 || !rows[r]?.cols?.length) return null;
  const c = rows[r].cols.length - 1;
  return { list: `rows.${r}.cols.${c}.els`, index: (rows[r].cols[c].els || []).length };
}

export { LIST_OF };
