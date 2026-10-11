// Browser tests: the editor and the site run on two different origins, exactly
// like production (editor.roetechnologyservices.com + roetechnologyservices.com).
// Needs a checkout of the site repo: SITE_DIR=../RTS npm run test:e2e
// GitHub is mocked, so nothing real is ever published.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, cp, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE_DIR = resolve(process.env.SITE_DIR || join(ROOT, 'site'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain', '.png': 'image/png', '.webp': 'image/webp' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==', 'base64');

// Static server like GitHub Pages: folder index.html, 404.html, and CORS for every file.
function staticServer(dir) {
  return createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dir, url));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/html' }).end('not found');
    }
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, () => r(`http://localhost:${srv.address().port}`)));

let browser; let site; let editor; let siteUrl; let editorUrl; let tmp;
const isNoise = (t) => /fonts\.g|ERR_CERT|ERR_TUNNEL|ERR_NAME|ERR_INTERNET|ERR_CONNECTION|ytimg|status of 404/.test(t);

before(async () => {
  await stat(join(SITE_DIR, 'assets/js/theme-api.js'));
  site = staticServer(SITE_DIR);
  siteUrl = await listen(site);
  // A copy of the editor configured for the local site.
  tmp = await mkdtemp(join(tmpdir(), 'rts-editor-'));
  await cp(ROOT, tmp, { recursive: true, filter: (src) => !/node_modules|\.git$|[/\\]site$/.test(src) });
  execFileSync(process.execPath, [join(ROOT, 'scripts/configure.mjs'), '--site', siteUrl, '--out', tmp]);
  editor = staticServer(tmp);
  editorUrl = await listen(editor);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); site?.close(); editor?.close(); if (tmp) await rm(tmp, { recursive: true, force: true }); });

async function newPage(ctx) {
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !isNoise(m.text()) && p.errors.push(m.text()));
  return p;
}

test('editor loads the theme and content from the site and publishes a full build', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const tree = []; const blobs = [];
  await ctx.route('https://api.github.com/**', async (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const json = (o, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (path === '/git/ref/heads/main') return json({ object: { sha: 'c0' } });
    if (path === '/git/commits/c0') return json({ tree: { sha: 't0' } });
    if (path === '/git/blobs') { blobs.push(JSON.parse(r.request().postData())); return json({ sha: `b${blobs.length - 1}` }); }
    if (path === '/contents/generated.json') return r.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify({ files: ['index.html', 'old-page/index.html'] }) });
    if (path === '/git/trees') { tree.push(...JSON.parse(r.request().postData()).tree); return json({ sha: 't1' }); }
    if (path === '/git/commits') return json({ sha: 'c1c1c1c1', html_url: 'https://github.com/x' });
    if (path === '/git/refs/heads/main') return json({});
    return json({ message: 'Not Found' }, 404);
  });
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  assert.ok(await canvas.locator('[data-section-id]').count() > 3, 'site content rendered in the canvas');

  // Connected-site panel names the site
  await p.click('.ed-rail button[data-tab="site"]');
  assert.match(await p.locator('.connected').innerText(), new RegExp(new URL(siteUrl).host));

  // Built-in images come from the site
  await p.click('.ed-rail button[data-tab="media"]');
  const bg = await p.locator('.ed-panel .media-grid').last().locator('.media-tile__img').first().getAttribute('style');
  assert.ok(bg.includes(siteUrl), 'library images load from the site');

  // Edit text, upload an image
  await canvas.locator('.hero__title').first().click();
  await p.keyboard.press('Control+a');
  await p.keyboard.type('Edited from the standalone editor');
  await canvas.locator('.blk-services').first().click();
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('.p-head button:has-text("Upload")')]);
  await chooser.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await p.locator('.ed-panel .media-grid').first().locator('.media-tile').first().waitFor();

  // Switch the color theme; the preview must show the draft's theme, not the site's defaults
  await p.click('.ed-rail button[data-tab="theme"]');
  await p.click('.preset:has-text("Emerald")');

  // Preview stays on the editor origin and shows the draft
  const [preview] = await Promise.all([ctx.waitForEvent('page'), p.click('#preview')]);
  await preview.locator('.hero__title').first().waitFor();
  assert.match(await preview.locator('.hero__title').first().innerText(), /Edited from the standalone editor/);
  const vars = await preview.evaluate(() => { const cs = getComputedStyle(document.documentElement); return [cs.getPropertyValue('--c-primary').trim(), cs.getPropertyValue('--font-head')]; });
  assert.equal(vars[0], '#059669', 'preview uses the draft color theme');
  const headingFont = JSON.parse(await readFile(join(SITE_DIR, 'content/site.json'), 'utf8')).theme.headingFont;
  assert.ok(vars[1].includes(headingFont), `preview uses the draft heading font (${vars[1]})`);
  await preview.click('.nav__list a:has-text("Services")');
  assert.ok(preview.url().startsWith(editorUrl) && /path=%2Fservices%2F/.test(preview.url()), preview.url());

  // Publish builds every page with the site's builder
  await p.click('#publish');
  await p.fill('.ed-modal input[type=password]', 'github_pat_TEST');
  await p.click('button:has-text("Publish now")');
  await p.locator('.log .ok', { hasText: 'Done' }).waitFor();
  const paths = tree.map((t) => t.path);
  for (const f of ['content/site.json', 'index.html', 'services/index.html', 'blog/index.html', 'sitemap.xml', 'feed.xml', 'generated.json']) assert.ok(paths.includes(f), f);
  assert.ok(paths.some((f) => /^assets\/uploads\/[0-9a-f]+\.(webp|png)$/.test(f)), 'uploaded image committed');
  assert.deepEqual(tree.filter((t) => t.sha === null).map((t) => t.path), ['old-page/index.html']);
  const read = (path) => Buffer.from(blobs[Number(tree.find((t) => t.path === path).sha.slice(1))].content, 'base64').toString();
  assert.match(read('index.html'), /Edited from the standalone editor/);
  assert.match(read('index.html'), /<link rel="canonical" href="https:\/\/roetechnologyservices\.com\/">/, 'canonical uses the site address, not the editor');
  assert.doesNotMatch(read('content/site.json'), /data:image/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('a foreign script cannot run in the editor', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const blocked = await p.evaluate(() => import('https://example.com/evil.js').then(() => false, () => true));
  assert.ok(blocked, 'CSP blocks scripts from other origins');
  await ctx.close();
});

test('an incompatible theme version shows a clear message instead of loading', async () => {
  const ctx = await browser.newContext();
  await ctx.route(`${siteUrl}/assets/js/theme-api.js`, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'export const EDITOR_API = 99;' }));
  const p = await ctx.newPage();
  await p.goto(`${editorUrl}/`);
  await p.locator('.ed-fatal').waitFor();
  assert.match(await p.locator('.ed-fatal').innerText(), /theme version 99/);
  await ctx.close();
});

test('an unreachable site shows a clear message', async () => {
  const ctx = await browser.newContext();
  await ctx.route(`${siteUrl}/**`, (r) => r.abort('connectionrefused'));
  const p = await ctx.newPage();
  await p.goto(`${editorUrl}/`);
  await p.locator('.ed-fatal').waitFor();
  assert.match(await p.locator('.ed-fatal').innerText(), /couldn’t load your site’s theme/);
  await ctx.close();
});

test('the editor refuses to run inside another site', async () => {
  const p = await browser.newPage();
  await p.setContent(`<iframe src="${editorUrl}/"></iframe>`);
  const frame = p.frames()[1];
  await frame.waitForFunction(() => document.body.innerText.includes('only be opened directly'));
  await p.close();
});
