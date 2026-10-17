import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindOf, locate, parentOf, getAt, exists, moveTo, moveBy, duplicateAt, evenSpans, setSpans, addColumn, removeColumn, moveBoundary, setStyle, nodeText, addTarget, shiftAfterRemoval,
} from '../../assets/js/layout-ops.js';

const sample = () => ({
  rows: [
    { cols: [{ span: 6, els: [{ type: 'heading', text: 'A' }, { type: 'text', html: '<p>B</p>' }, { type: 'box', els: [{ type: 'button', label: 'C' }] }] }, { span: 6, els: [] }] },
    { cols: [{ span: 12, els: [{ type: 'image' }] }] },
  ],
});
const texts = (d, path) => getAt(d, path).map((e) => e.text || e.label || e.type);

test('paths: kind, list, parent', () => {
  assert.equal(kindOf('rows.1'), 'row');
  assert.equal(kindOf('rows.0.cols.1'), 'col');
  assert.equal(kindOf('rows.0.cols.1.els.2.els.0'), 'el');
  assert.deepEqual(locate('rows.0.cols.1.els.2'), { list: 'rows.0.cols.1.els', index: 2 });
  assert.equal(parentOf('rows.0.cols.1.els.2'), 'rows.0.cols.1');
  assert.equal(parentOf('rows.0'), null);
  assert.ok(exists(sample(), 'rows.0.cols.0.els.2.els.0'));
  assert.equal(exists(sample(), 'rows.0.cols.0.els.9'), false);
  assert.equal(shiftAfterRemoval('rows.0.cols.0.els.2.els', 'rows.0.cols.0.els.1'), 'rows.0.cols.0.els.1.els');
  assert.equal(shiftAfterRemoval('rows.1', 'rows.0.cols.0.els.1'), 'rows.1');
});

test('moving elements within a column, between columns, into boxes and sections', () => {
  let d = sample();
  assert.equal(moveTo(d, 'rows.0.cols.0.els.0', d, 'rows.0.cols.0.els', 2), 'rows.0.cols.0.els.1');
  assert.deepEqual(texts(d, 'rows.0.cols.0.els'), ['text', 'A', 'box']);
  d = sample();
  assert.equal(moveTo(d, 'rows.0.cols.0.els.1', d, 'rows.0.cols.1.els', 0), 'rows.0.cols.1.els.0');
  assert.deepEqual(texts(d, 'rows.0.cols.1.els'), ['text']);
  d = sample();
  // Into the box after it: the box's own path moves up by one.
  assert.equal(moveTo(d, 'rows.0.cols.0.els.0', d, 'rows.0.cols.0.els.2.els', 1), 'rows.0.cols.0.els.1.els.1');
  assert.deepEqual(texts(d, 'rows.0.cols.0.els.1.els'), ['C', 'A']);
  d = sample();
  assert.equal(moveTo(d, 'rows.0.cols.0.els.2', d, 'rows.0.cols.0.els.2.els', 0), null, 'a box cannot go inside itself');
  assert.equal(moveTo(d, 'rows.0.cols.0.els.0', d, 'rows', 0), null, 'an element is not a row');
  assert.equal(moveTo(d, 'rows.0.cols.0.els.0', d, 'rows.0.cols.0.els', 1), 'rows.0.cols.0.els.0', 'dropping in place changes nothing');
  const other = { rows: [{ cols: [{ span: 12, els: [] }] }] };
  assert.equal(moveTo(d, 'rows.1', other, 'rows', 0), 'rows.0');
  assert.equal(d.rows.length, 1);
  assert.equal(other.rows.length, 2);
  d = sample();
  assert.equal(moveTo(d, 'rows.0.cols.1', d, 'rows.1.cols', 1), 'rows.1.cols.1');
  assert.equal(d.rows[0].cols.length, 1);
});

test('move up/down, duplicate', () => {
  const d = sample();
  assert.equal(moveBy(d, 'rows.0.cols.0.els.0', 1), 'rows.0.cols.0.els.1');
  assert.equal(moveBy(d, 'rows.0.cols.0.els.0', -1), 'rows.0.cols.0.els.0');
  assert.equal(duplicateAt(d, 'rows.0.cols.0.els.2'), 'rows.0.cols.0.els.3');
  d.rows[0].cols[0].els[3].els[0].label = 'changed';
  assert.equal(d.rows[0].cols[0].els[2].els[0].label, 'C', 'a copy is independent');
});

test('column widths', () => {
  assert.deepEqual(evenSpans(5), [3, 3, 2, 2, 2]);
  assert.deepEqual(evenSpans(3), [4, 4, 4]);
  const row = sample().rows[0];
  setSpans(row, [12]);
  assert.equal(row.cols.length, 1);
  assert.deepEqual(row.cols[0].els.map((e) => e.type), ['heading', 'text', 'box'], 'content of removed columns is kept');
  setSpans(row, [4, 8]);
  assert.deepEqual(row.cols.map((c) => c.span), [4, 8]);
  assert.equal(addColumn(row, 0), 1);
  assert.deepEqual(row.cols.map((c) => c.span), [4, 4, 4]);
  assert.ok(moveBoundary(row, 0, 2));
  assert.deepEqual(row.cols.map((c) => c.span), [6, 2, 4]);
  moveBoundary(row, 0, 5);
  assert.deepEqual(row.cols.map((c) => c.span), [7, 1, 4], 'both columns keep at least one twelfth');
  assert.equal(moveBoundary(row, 2, 1), false);
  removeColumn(row, 1);
  assert.deepEqual(row.cols.map((c) => c.span), [8, 4], 'the width goes to the column before');
  removeColumn(row, 0);
  assert.deepEqual(row.cols.map((c) => c.span), [12]);
});

test('styles: setting, phone changes and clearing', () => {
  const n = {};
  setStyle(n, 'pt', 20);
  setStyle(n, 'pt', 10, 'mobile');
  assert.deepEqual(n, { design: { pt: 20 }, mobile: { pt: 10 } });
  setStyle(n, 'pt', '', 'mobile');
  setStyle(n, 'pt', null);
  assert.deepEqual(n, {});
});

test('summaries and where new elements go', () => {
  assert.equal(nodeText({ html: '<p>Hello&nbsp;<b>you</b> &amp; me</p>' }), 'Hello you & me');
  assert.equal(nodeText({ text: 'x'.repeat(50) }).length, 41);
  const d = sample();
  assert.deepEqual(addTarget(d, 'rows.0.cols.0.els.0'), { list: 'rows.0.cols.0.els', index: 1 });
  assert.deepEqual(addTarget(d, 'rows.0.cols.0.els.2'), { list: 'rows.0.cols.0.els.2.els', index: 1 });
  assert.deepEqual(addTarget(d, 'rows.0.cols.1'), { list: 'rows.0.cols.1.els', index: 0 });
  assert.deepEqual(addTarget(d, 'rows.0'), { list: 'rows.0.cols.1.els', index: 0 });
  assert.deepEqual(addTarget(d, null), { list: 'rows.1.cols.0.els', index: 1 });
  assert.equal(addTarget({ rows: [] }, null), null);
});
