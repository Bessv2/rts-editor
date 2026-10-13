import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteAsset, SITE } from '../../assets/js/config.js';

// A stand-in for the theme's safeSrc: site-relative paths become root-relative.
const safeSrc = (v) => (!v ? '' : /^(data:|https?:|\/)/.test(v) ? v : `/${v}`);

test('site images resolve against the site, whatever form the address takes', () => {
  assert.equal(siteAsset('assets/a.png', safeSrc), `${SITE}/assets/a.png`);
  assert.equal(siteAsset('/assets/a.png', safeSrc), `${SITE}/assets/a.png`);
  assert.equal(siteAsset('//cdn.example.com/a.png', safeSrc), 'https://cdn.example.com/a.png');
  assert.equal(siteAsset('https://x.com/a.png', safeSrc), 'https://x.com/a.png');
  assert.equal(siteAsset('data:image/png;base64,AA', safeSrc), 'data:image/png;base64,AA');
  assert.equal(siteAsset('', safeSrc), '');
});
