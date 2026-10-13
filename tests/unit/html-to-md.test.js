import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHandlers, hasFormatting } from '../../assets/js/html-to-md.js';

test('inline event handlers are removed before the markup is parsed', () => {
  assert.equal(stripHandlers('<img src="x" onerror="alert(1)">'), '<img src="x" >');
  assert.equal(stripHandlers('<svg viewBox="0 0 1 1" ONLOAD=\'alert(1)\'><rect/></svg>'), '<svg viewBox="0 0 1 1" ><rect/></svg>');
  assert.equal(stripHandlers('<img/onerror=alert(1)>'), '<img/>');
  assert.equal(stripHandlers('<a title="a > b" onclick="x()" href="/y">t</a>'), '<a title="a > b" href="/y">t</a>'.replace('" href', '"  href'));
  assert.equal(stripHandlers('<p class="x"onmouseover="x()">turn on = yes</p>'), '<p class="x">turn on = yes</p>', 'text outside tags is untouched');
  assert.equal(stripHandlers('<a href="javascript:alert(1)">x</a><a xlink:href = \' JavaScript:x\'>y</a>'), '<a >x</a><a >y</a>');
  assert.equal(stripHandlers('<a href="/javascript-tips/">x</a>'), '<a href="/javascript-tips/">x</a>');
  assert.equal(stripHandlers('<b style="font-weight:normal" id="docs-internal-guid-1">x</b>'), '<b style="font-weight:normal" id="docs-internal-guid-1">x</b>');
});

test('only formatted clipboard HTML is converted', () => {
  assert.equal(hasFormatting('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p>x</p></b>'), true);
  assert.equal(hasFormatting('<p class=MsoNormal>x</p>'), true);
  assert.equal(hasFormatting('<div><span style="color:red">const a = 1;</span></div>'), false);
});
