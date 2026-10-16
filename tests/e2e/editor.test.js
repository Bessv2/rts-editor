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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

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

// Fake GitHub API: records the committed tree and lets tests read committed files.
// Routes are matched by method too, like GitHub: the branch is read from
// /git/ref/heads/… but moved with a PATCH to /git/refs/heads/….
// token: 'ok' (default), 'bad' (401 everywhere) or 'read-only' (saving is refused).
async function mockGitHub(ctx, { contentSha, token = 'ok' } = {}) {
  const tree = []; const blobs = []; const commits = []; const refs = [];
  await ctx.route('https://api.github.com/**', async (r) => {
    const method = r.request().method();
    const path = new URL(r.request().url()).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const json = (o, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    const is = (m, p) => method === m && path === p;
    if (token === 'bad') return json({ message: 'Bad credentials' }, 401);
    if (is('GET', '/user')) return json({ login: 'site-owner' });
    if (is('GET', '')) return json({ full_name: 'o/r' });
    if (is('GET', '/branches/main')) return json({ name: 'main' });
    if (is('GET', '/git/ref/heads/main')) return json({ object: { sha: 'c0' } });
    if (is('GET', '/git/commits/c0')) return json({ tree: { sha: 't0' } });
    if (is('POST', '/git/blobs')) {
      if (token === 'read-only') return json({ message: 'Resource not accessible by personal access token' }, 403);
      blobs.push(JSON.parse(r.request().postData())); return json({ sha: `b${blobs.length - 1}` });
    }
    if (is('GET', '/contents/generated.json')) return r.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify({ files: ['index.html', 'old-page/index.html'] }) });
    if (is('POST', '/git/trees')) { tree.push(...JSON.parse(r.request().postData()).tree); return json({ sha: 't1' }); }
    if (is('GET', '/contents/content/site.json') && contentSha) return json({ sha: contentSha });
    if (is('POST', '/git/commits')) { commits.push(1); return json({ sha: 'c1c1c1c1', html_url: 'https://github.com/x' }); }
    if (is('PATCH', '/git/refs/heads/main')) { refs.push(JSON.parse(r.request().postData()).sha); return json({ object: { sha: refs.at(-1) } }); }
    return json({ message: 'Not Found' }, 404);
  });
  const read = (path) => Buffer.from(blobs[Number(tree.find((t) => t.path === path).sha.slice(1))].content, 'base64').toString();
  return { tree, read, commits, refs };
}

const gitSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

async function publish(p) {
  await p.click('#publish');
  await p.fill('.ed-modal input[type=password]', 'github_pat_TEST');
  await p.click('button:has-text("Publish now")');
  await p.locator('.log .ok', { hasText: 'Done' }).waitFor();
}

// news: show the one-time "What's new" note (only its own test wants it; elsewhere it
// would sit over the bottom of the page while a test clicks or drags there).
async function newPage(ctx, { news = false } = {}) {
  const p = await ctx.newPage();
  if (!news) await p.addInitScript(() => { try { localStorage.setItem('whats-new-seen', '999'); } catch { /* storage blocked */ } });
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !isNoise(m.text()) && p.errors.push(m.text()));
  return p;
}

test('editor loads the theme and content from the site and publishes a full build', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const gh = await mockGitHub(ctx);
  const { tree, read } = gh;
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
  // In-page links stay in the preview even though <base> points at the site
  await preview.evaluate(() => document.querySelector('.skip-link').click());
  await preview.waitForTimeout(200);
  assert.ok(preview.url().startsWith(editorUrl), `skip link stays in the preview: ${preview.url()}`);

  // Publish builds every page with the site's builder and moves the branch to the new commit
  await publish(p);
  assert.deepEqual(gh.refs, ['c1c1c1c1'], 'main now points at the new commit');
  const paths = tree.map((t) => t.path);
  for (const f of ['content/site.json', 'index.html', 'services/index.html', 'blog/index.html', 'sitemap.xml', 'feed.xml', 'generated.json']) assert.ok(paths.includes(f), f);
  assert.ok(paths.some((f) => /^assets\/uploads\/[0-9a-f]+\.(webp|png)$/.test(f)), 'uploaded image committed');
  assert.deepEqual(tree.filter((t) => t.sha === null).map((t) => t.path), ['old-page/index.html']);
  assert.match(read('index.html'), /Edited from the standalone editor/);
  assert.match(read('index.html'), /<link rel="canonical" href="https:\/\/roetechnologyservices\.com\/">/, 'canonical uses the site address, not the editor');
  assert.doesNotMatch(read('content/site.json'), /data:image/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('page options: unpublish, hide from search engines, renamed pages keep their old address', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('redirects')) { t.skip('the site does not support page options yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { tree, read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  const pageIndex = (title) => p.locator('#page-select option').evaluateAll((os, t) => os.findIndex((o) => o.textContent === t), title);
  const goTo = async (title) => { await p.selectOption('#page-select', String(await pageIndex(title))); await p.click('.ed-rail button[data-tab="pages"]'); };
  const toggle = (label) => p.locator(`.page-item.is-current label.switch:has-text("${label}") input`);

  // Rename a live page: the old address is kept as a redirect
  await goTo('Services');
  await p.fill('.page-slug', 'what-we-do');
  await p.press('.page-slug', 'Tab');
  await p.locator('.toast', { hasText: 'Visitors to /services/ will be sent to /what-we-do/' }).waitFor();

  // Unpublish a page, hide another from search engines
  await goTo('About');
  await toggle('Show on website').uncheck();
  assert.match(await p.locator('#page-select option:checked').innerText(), /unpublished/);
  await goTo('Contact');
  await toggle('Hide from search engines').check();

  // The redirect is listed in Settings
  await p.click('.ed-rail button[data-tab="site"]');
  assert.match(await p.locator('.redirect-row').first().innerText(), /\/services\/\s*→\s*\/what-we-do\//);

  // Unpublished pages can still be previewed
  await p.selectOption('#page-select', String(await pageIndex('About (unpublished)')));
  const [preview] = await Promise.all([ctx.waitForEvent('page'), p.click('#preview')]);
  await preview.waitForFunction(() => document.title === 'Preview: About');
  await preview.close();

  await publish(p);
  const paths = tree.map((x) => x.path);
  assert.ok(paths.includes('what-we-do/index.html'));
  assert.match(read('services/index.html'), /<meta http-equiv="refresh" content="0; url=\/what-we-do\/">/);
  assert.ok(!paths.includes('about/index.html'), 'unpublished page is not built');
  assert.match(read('contact/index.html'), /<meta name="robots" content="noindex">/);
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /\/what-we-do\//);
  assert.doesNotMatch(sitemap, /\/(about|contact|services)\//);
  const content = JSON.parse(read('content/site.json'));
  assert.deepEqual(content.redirects, [{ from: '/services/', to: '/what-we-do/' }]);
  assert.equal(content.pages.find((x) => x.title === 'About').draft, true);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('checkup finds problems, blocks publishing on errors and shows where they are', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('audit')) { t.skip('the site has no checkup yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  const tab = p.locator('.ed-rail button[data-tab="checkup"]');
  assert.ok(await tab.isVisible(), 'Checkup tab is shown when the site supports it');
  assert.ok(await tab.locator('.ed-rail__badge').isHidden(), 'the published site has nothing to fix');

  // A new section with sample text is flagged and underlined on the canvas
  await p.click('.ed-rail button[data-tab="add"]');
  await p.click('.block-card:has-text("Services grid")');
  await tab.locator('.ed-rail__badge').waitFor();
  await canvas.locator('.ed-sample').first().waitFor();

  // Removing every way the contact form can send messages is an error that blocks publishing
  await p.click('.ed-rail button[data-tab="site"]');
  await p.fill('#panel [data-path="email"]', '');
  await p.fill('#panel [data-path="formEndpoint"]', '');
  await p.click('#publish');
  await p.locator('.pub-checks.has-err').waitFor();
  assert.match(await p.locator('.pub-checks').innerText(), /contact form has nowhere to send messages/);
  assert.ok(await p.locator('button:has-text("Publish now")').isDisabled());
  await p.locator('.pub-checks .check--error button:has-text("Show me")').click();
  await p.waitForFunction(() => document.activeElement?.dataset.path === 'email');
  await p.fill('#panel [data-path="email"]', 'help@example.com');

  // The Checkup tab lists the sample text; Show me selects that section
  await tab.click();
  await p.locator('#panel .check--warning', { hasText: 'sample text' }).waitFor();
  assert.equal(await p.locator('#panel .check--error').count(), 0, 'the error is gone once an email is set');
  await p.locator('#panel .check--warning', { hasText: 'sample text' }).locator('button').click();
  await canvas.locator('.blk-services.is-selected').last().waitFor();
  assert.match(await p.locator('#inspector .p-head').innerText(), /Services grid/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('pasting from Word or Google Docs keeps formatting; code and tip box buttons', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  const gdocs = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h1 dir="ltr"><span style="font-weight:700">Backups</span></h1>'
    + '<p dir="ltr"><span style="font-weight:400">Keep </span><span style="font-weight:700">three</span><span style="font-weight:400"> copies, </span><span style="font-style:italic">offsite</span><span>. See </span><a href="https://example.com/x"><span>this guide</span></a></p>'
    + '<ul><li><p><span>Daily</span></p></li><li><p><span>Weekly</span></p></li></ul></b>';
  const word = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal><b>Title line</b><o:p></o:p></p>'
    + "<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>1.<span>&nbsp;&nbsp;</span></span>First</p>"
    + "<p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>2.<span>&nbsp;</span></span>Second</p></body></html>";
  const out = await p.evaluate(async ([g, w]) => {
    const m = await import('./assets/js/html-to-md.js');
    return {
      g: m.htmlToMarkdown(g), w: m.htmlToMarkdown(w),
      unsafe: m.htmlToMarkdown('<p>Hi<script>alert(1)</script> <img src="x" onerror="alert(1)"> <a href="javascript:alert(1)">x</a></p>'),
      plain: m.hasFormatting('<div><span style="color:red">const a = 1;</span></div>'),
    };
  }, [gdocs, word]);
  assert.equal(out.g, '## Backups\n\nKeep **three** copies, *offsite*. See [this guide](https://example.com/x)\n\n- Daily\n- Weekly');
  assert.equal(out.w, '**Title line**\n\n1. First\n2. Second');
  assert.equal(out.unsafe, 'Hi x');
  assert.equal(out.plain, false, 'code editor HTML is pasted as plain text');

  // Paste into a new post
  await p.click('.ed-rail button[data-tab="blog"]');
  await p.click('button:has-text("New post")');
  const body = p.locator('#panel textarea[data-path="body"]');
  await body.focus();
  await p.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', 'Backups Keep three copies');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, gdocs);
  assert.match(await body.inputValue(), /^## Backups\n\nKeep \*\*three\*\*/);
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.post__body h2', { hasText: 'Backups' }).waitFor();

  if (!theme.FEATURES?.includes('callouts')) return;
  await p.click('#panel .md-tools button[title="Tip box"]');
  assert.match(await body.inputValue(), /\n\n> \[!TIP\]\n> A helpful tip\.\n$/);
  await canvas.locator('.post__body .callout--tip').waitFor();
  await p.click('#panel .md-tools button[title="Code block"]');
  await canvas.locator('.post__body pre.code').waitFor();
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('publishing over changes made somewhere else asks first', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const gh = await mockGitHub(ctx, { contentSha: 'f'.repeat(40) });
  const p = await newPage(ctx);
  const dialogs = [];
  let accept = false;
  p.on('dialog', (d) => { dialogs.push(d.message()); return accept ? d.accept() : d.dismiss(); });
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().click();
  await p.keyboard.type(' (edited)');
  await canvas.locator('.blk-services').first().click();
  await p.click('#publish');
  await p.fill('.ed-modal input[type=password]', 'github_pat_TEST');
  await p.click('button:has-text("Publish now")');
  await p.locator('.log .err', { hasText: 'Publishing cancelled' }).waitFor();
  assert.match(dialogs[0], /changed somewhere else/);
  assert.equal(gh.commits.length, 0, 'nothing is committed when cancelled');
  accept = true;
  await p.click('button:has-text("Publish now")');
  await p.locator('.log .ok', { hasText: 'Done' }).waitFor();
  assert.equal(gh.commits.length, 1);
  assert.equal(dialogs.length, 2, 'asked once per publish attempt');
  await ctx.close();

  // No question when the repository still has the version the draft started from
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await mockGitHub(ctx2, { contentSha: gitSha(await readFile(join(SITE_DIR, 'content/site.json'))) });
  const p2 = await newPage(ctx2);
  p2.on('dialog', (d) => { dialogs.push(d.message()); return d.dismiss(); });
  await p2.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p2.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  await publish(p2);
  assert.equal(dialogs.length, 2, 'no new question');
  await ctx2.close();
});

test('the editor remembers where you were and notices drafts that went stale', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  const services = await p.locator('#page-select option').evaluateAll((os) => os.findIndex((o) => o.textContent === 'Services'));
  await p.selectOption('#page-select', String(services));
  await p.click('.ed-rail button[data-tab="pages"]');
  assert.equal(new URL(p.url()).hash, '#page=services&tab=pages');

  // Make a draft, then pretend the live site was changed from another computer
  await canvas.locator('.hero__title').first().click();
  await p.keyboard.type(' draft');
  await canvas.locator('.site-footer').click();
  await p.waitForTimeout(700);
  await p.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('rts-editor', 1);
    req.onsuccess = () => {
      const store = req.result.transaction('kv', 'readwrite').objectStore('kv');
      const get = store.get('draft');
      get.onsuccess = () => { store.put({ ...get.result, base: 'a'.repeat(40) }, 'draft'); store.delete('known-bases'); };
      store.transaction.oncomplete = resolve;
      store.transaction.onerror = reject;
    };
  }));

  await p.reload({ waitUntil: 'load' });
  await canvas.locator('.hero__title').first().waitFor();
  assert.equal(await p.locator('#page-select option:checked').innerText(), 'Services', 'same page after reload');
  assert.ok(await p.locator('.ed-rail button[data-tab="pages"]').evaluate((b) => b.classList.contains('is-on')), 'same panel after reload');
  await p.locator('.toast', { hasText: 'changed somewhere else' }).waitFor();

  // Posts are remembered too
  await p.click('.ed-rail button[data-tab="blog"]');
  await p.locator('.post-row').first().click();
  assert.match(new URL(p.url()).hash, /^#post=/);
  await p.reload({ waitUntil: 'load' });
  await p.locator('#panel h2', { hasText: /Edit (post|blurb)/ }).waitFor();
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('drafts and settings stay with their site; uploaded SVGs are cleaned', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  await p.evaluate(() => new Promise((resolve) => {
    localStorage.setItem('rts-editor-github', JSON.stringify({ owner: 'someone', repo: 'other', branch: 'dev', token: '', site: 'https://other.example|someone/other' }));
    const req = indexedDB.open('rts-editor', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ savedAt: Date.now(), json: JSON.stringify({ site: { name: 'Other site' }, pages: [{ title: 'Other home', sections: [] }] }), site: 'https://other.example|someone/other' }, 'draft');
      tx.oncomplete = resolve;
    };
  }));
  await p.reload({ waitUntil: 'load' });
  await p.locator('.toast', { hasText: 'draft for another site (https://other.example) was set aside' }).waitFor();
  assert.notEqual(await p.locator('#page-select option').first().innerText(), 'Other home', 'the other site’s draft is not loaded');
  await p.click('#publish');
  assert.equal(await p.locator('.ed-modal input[placeholder="GitHub user"]').inputValue(), 'Bessv2', 'another site’s repository is not used');
  await p.click('.ed-modal__card header [data-close]');

  // SVG uploads keep the drawing but lose scripts and event handlers
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script>'
    + '<a xlink:href="javascript:alert(3)"><rect width="10" height="10" fill="#2563eb"/></a><foreignObject><div>x</div></foreignObject></svg>';
  await p.click('.ed-rail button[data-tab="media"]');
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('.p-head button:has-text("Upload")')]);
  await chooser.setFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await p.locator('.ed-panel .media-grid').first().locator('.media-tile').first().waitFor();
  await p.waitForTimeout(300);
  const stored = await p.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('rts-editor', 1);
    req.onsuccess = () => { const g = req.result.transaction('kv').objectStore('kv').get('draft'); g.onsuccess = () => resolve(g.result.json); };
  }));
  const src = JSON.parse(stored).media.find((m) => m.name === 'logo.svg').src;
  const clean = Buffer.from(src.split(',')[1], 'base64').toString();
  assert.match(clean, /<rect/);
  assert.doesNotMatch(clean, /script|onload|javascript:|foreignObject/i);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('section names, search and share previews, search engine codes and scheduled posts', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('verification')) { t.skip('the site does not support these options yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();

  // Name a section; Layers and the canvas use the name
  await canvas.locator('.blk-services').first().click();
  await p.fill('#inspector [data-path="__label"]', 'What we offer');
  await canvas.locator('.ed-chip', { hasText: 'What we offer' }).waitFor();
  await p.click('.ed-rail button[data-tab="layers"]');
  await p.locator('.layer.is-sel strong', { hasText: 'What we offer' }).waitFor();

  // Show a section on phones only: the editor marks it
  await p.locator('#inspector .f', { hasText: 'Show on' }).locator('button', { hasText: 'Phones' }).click();
  await canvas.locator('.blk-services.show-on--mobile').first().waitFor();

  // Google and share previews follow the page settings
  await p.click('.ed-rail button[data-tab="pages"]');
  await p.fill('.page-item.is-current [data-path="seoTitle"]', 'IT help for small offices');
  assert.match(await p.locator('.serp strong').innerText(), /IT help for small offices/);
  assert.ok(await p.locator('.share-card').isVisible());
  assert.ok(await p.locator('.page-item.is-current .f', { hasText: 'Share image for this page' }).isVisible());

  // Search engine codes accept the whole <meta> tag
  await p.click('.ed-rail button[data-tab="site"]');
  await p.fill('#panel [data-path="googleVerification"]', '<meta name="google-site-verification" content="AbC-123_x" />');
  await p.press('#panel [data-path="googleVerification"]', 'Tab');
  assert.equal(await p.inputValue('#panel [data-path="googleVerification"]'), 'AbC-123_x');

  // A post dated in the future is marked as scheduled and left out of the build
  await p.click('.ed-rail button[data-tab="blog"]');
  await p.click('button:has-text("New post")');
  await p.fill('#panel [data-path="title"]', 'Coming soon post');
  await p.fill('#panel input[type="date"]', '2999-01-01');
  await p.dispatchEvent('#panel input[type="date"]', 'change');
  await p.click('#panel .p-head button[title="Back to all entries"]');
  await p.locator('.post-row', { hasText: 'Coming soon post' }).locator('.badge', { hasText: 'Scheduled' }).waitFor();

  await publish(p);
  assert.match(read('index.html'), /<meta name="google-site-verification" content="AbC-123_x">/);
  assert.doesNotMatch(read('blog/index.html'), /Coming soon post/);
  const content = JSON.parse(read('content/site.json'));
  assert.ok(content.pages[0].sections.some((x) => x.label === 'What we offer' && x.data.showOn === 'mobile'));
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('the link picker links pages, sections, posts, email and web addresses', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  const dialogs = [];
  p.on('dialog', (d) => { dialogs.push(d.message()); return d.accept(); });
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().click();
  const href = '#inspector [data-path="primary.href"]';
  const choose = () => p.locator('#inspector .f', { has: p.locator('[data-path="primary.href"]') }).locator('button', { hasText: 'Choose' }).click();
  const modal = p.locator('.ed-modal');

  // A page, found by searching
  await choose();
  await modal.locator('input[type=search]').fill('serv');
  assert.ok(await modal.locator('.link-page__head .link-row', { hasText: 'About' }).isHidden(), 'pages that do not match are hidden');
  await modal.locator('.link-page__head .link-row', { hasText: 'Services' }).click();
  assert.equal(await p.inputValue(href), '/services/');

  // A section on the same page without an anchor gets one and is linked with #
  await choose();
  assert.ok(await modal.locator('.link-row.is-on', { hasText: 'Services' }).isVisible(), 'the current link is highlighted');
  await modal.locator('.link-row--sub', { hasText: 'A simple, proven process' }).click();
  assert.equal(await p.inputValue(href), '#a-simple-proven-process');
  await canvas.locator('section#a-simple-proven-process').waitFor();
  await p.locator('.toast', { hasText: 'can now be linked to as #a-simple-proven-process' }).waitFor();

  // A section on another page is linked with its page address
  await choose();
  const contact = modal.locator('.link-page', { has: p.locator('.link-page__head', { hasText: 'Contact' }) });
  await contact.locator('.link-more').click();
  await contact.locator('.link-row--sub').first().click();
  assert.match(await p.inputValue(href), /^\/contact\/#[\w-]+$/);

  // A typed web address is completed
  await choose();
  await modal.locator('.link-pick__url input').fill('example.com/help');
  await modal.locator('button', { hasText: 'Use link' }).click();
  assert.equal(await p.inputValue(href), 'https://example.com/help');

  // The Link button in the post editor uses the picker too
  await p.click('.ed-rail button[data-tab="blog"]');
  await p.click('button:has-text("New post")');
  await p.fill('#panel [data-path="title"]', 'Linking test');
  const body = p.locator('#panel textarea.md-in').first();
  await body.fill('Write to us today.');
  await body.evaluate((ta) => { ta.focus(); ta.setSelectionRange(0, 11); });
  await p.click('#panel .md-tools button[title="Link"]');
  const email = JSON.parse(await readFile(join(SITE_DIR, 'content/site.json'), 'utf8')).site.email;
  await modal.locator('.link-row', { hasText: `Email ${email}` }).click();
  assert.equal(await body.inputValue(), `[Write to us](mailto:${email}) today.`);
  assert.deepEqual(dialogs, [], 'no browser prompts');

  await publish(p);
  const content = JSON.parse(read('content/site.json'));
  const hero = content.pages[0].sections.find((x) => x.type === 'hero');
  assert.equal(hero.data.primary.href, 'https://example.com/help');
  assert.ok(content.pages[0].sections.some((x) => x.data.anchor === 'a-simple-proven-process'));
  assert.match(read('index.html'), /<section[^>]*id="a-simple-proven-process"/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('booking calendars: placeholder while editing, allowed in the preview', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('booking')) { t.skip('the site does not support booking calendars yet'); return; }
  const previewCsp = (await readFile(join(tmp, 'preview.html'), 'utf8')).match(/frame-src [^;"]*/)[0];
  for (const origin of theme.BOOKING_ORIGINS) assert.ok(previewCsp.includes(origin), `preview allows ${origin}`);

  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  await p.click('.ed-rail button[data-tab="add"]');
  await p.click('.block-card:has-text("Booking calendar")');
  await canvas.locator('.booking .map__placeholder', { hasText: 'Paste your booking link' }).waitFor();
  await p.fill('#inspector [data-path="url"]', 'https://calendly.com/roe/30min');
  await canvas.locator('.booking .map__placeholder', { hasText: 'Calendly calendar' }).waitFor();
  assert.equal(await canvas.locator('.booking iframe').count(), 0, 'the live calendar is not loaded while editing');

  const [preview] = await Promise.all([ctx.waitForEvent('page'), p.click('#preview')]);
  await preview.locator('.booking__frame').waitFor({ state: 'attached' });
  assert.equal(await preview.locator('.booking__frame').getAttribute('src'), 'https://calendly.com/roe/30min');

  await publish(p);
  assert.match(read('index.html'), /<iframe class="booking__frame" src="https:\/\/calendly.com\/roe\/30min"/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('elements: add headings, text, buttons and images to a section and arrange them', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('elements')) { t.skip('the site does not support elements yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  const sec = canvas.locator('.blk-split').first();
  await sec.click();
  const add = (label) => p.locator('#inspector .el-add__btn', { hasText: new RegExp(`^${label}$`) }).click();
  const count = () => sec.locator('[data-el]').count();

  // A new heading is ready to type over on the page
  await add('Heading');
  await sec.locator('[data-el="0"] .el-heading[data-edit]:focus').waitFor();
  await p.keyboard.type('Why clients stay');
  assert.equal(await p.inputValue('#inspector [data-path="elements.0.text"]'), 'Why clients stay');
  await add('Text');
  await sec.locator('[data-el="1"] .el-text:focus').waitFor();
  await p.keyboard.type('We answer within a day.');
  await add('Button');
  await p.fill('#inspector [data-path="elements.2.label"]', 'Call us');
  await sec.locator('[data-el="2"] .btn', { hasText: 'Call us' }).waitFor();

  // An empty image opens the library when clicked on the page
  await add('Image');
  await sec.locator('[data-el="3"] .figure__empty').click();
  await p.locator('#modal .media-tile__img').first().click();
  await sec.locator('[data-el="3"] img').waitFor();
  await p.locator('#inspector [data-el-card="3"] .f', { hasText: 'Width' }).locator('button', { hasText: '½' }).click();
  await sec.locator('[data-el="3"].el--half').waitFor();
  assert.equal(await p.locator('#inspector .list-item.is-open').count(), 1, 'only the selected element is open in the panel');

  // The toolbar on a selected element moves, duplicates and removes it
  await sec.locator('[data-el="0"]').click();
  await sec.locator('[data-el="0"] .ed-el-tools [data-tool="el-down"]').click();
  assert.match(await sec.locator('[data-el="1"]').innerText(), /Why clients stay/);
  await sec.locator('[data-el="1"] .ed-el-tools [data-tool="el-copy"]').click();
  assert.equal(await count(), 5);
  await sec.locator('[data-el="2"] .ed-el-tools [data-tool="el-delete"]').click();
  assert.equal(await count(), 4);
  // Delete with an element selected removes the element, not the section
  await sec.locator('[data-el="1"]').click();
  await p.keyboard.press('Escape'); // leave the heading text, keep the element selected
  await p.keyboard.press('Control+d');
  assert.equal(await count(), 5);
  await p.keyboard.press('Delete');
  assert.equal(await count(), 4);
  assert.equal(await canvas.locator('.blk-split').count(), 1);

  // The section toolbar adds elements too
  await sec.locator('.ed-tools [data-tool="elements"]').click();
  await p.locator('#modal .el-tile', { hasText: 'Line' }).click();
  await sec.locator('[data-el="4"] .el-divider').waitFor();

  await publish(p);
  const html = read('index.html');
  assert.match(html, /<div class="elements">.*<p>We answer within a day\.<\/p>.*<h2 class="el-heading el-heading--medium">Why clients stay<\/h2>/s);
  assert.match(html, /<div class="el el--half el--center"><figure class="el-figure el-figure--medium el-figure--round"><img src="[^"]+"/);
  assert.match(html, /<a class="btn btn--primary" href="\/contact\/"><span>Call us<\/span><\/a>/);
  assert.match(html, /<hr class="el-divider">/);
  assert.doesNotMatch(html, /data-el=|ed-el-tools|ed-ins/, 'no editor markup is published');
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('drag and drop: sections and elements on the page, element cards in the panel', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('elements')) { t.skip('the site does not support elements yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  await mockGitHub(ctx);
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  const order = () => canvas.locator('main > [data-section-id]').evaluateAll((ns) => ns.map((n) => [...n.classList].find((c) => c.startsWith('blk-'))));
  // A real drag with small mouse steps; both points must be on screen (scrolling mid-drag cancels it).
  const drag = async (from, to, { x = 20, y = 10 } = {}) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const ax = a.x + a.width / 2; const ay = a.y + a.height / 2; const bx = b.x + x; const by = b.y + y;
    await p.mouse.move(ax, ay);
    await p.mouse.down();
    for (let i = 1; i <= 12; i++) await p.mouse.move(ax + ((bx - ax) * i) / 12, ay + ((by - ay) * i) / 12);
    await p.mouse.up();
  };

  // A section dragged by its grip onto the top half of another lands above it
  const services = canvas.locator('.blk-services').first();
  await services.click({ position: { x: 5, y: 5 } });
  const logos = canvas.locator('.blk-logos').first();
  await logos.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await drag(services.locator('.ed-tools .ed-grip'), logos, { x: 200, y: (await logos.boundingBox()).height * 0.3 });
  let list = await order();
  assert.equal(list[list.indexOf('blk-logos') - 1], 'blk-services');
  await p.locator('.toast', { hasText: 'Section moved' }).waitFor();

  // Elements: reorder by dragging on the page, then move one into the next section
  const sec = canvas.locator('.blk-split').first();
  await sec.click({ position: { x: 5, y: 5 } });
  for (const label of ['Heading', 'Text', 'Button']) await p.locator('#inspector .el-add__btn', { hasText: new RegExp(`^${label}$`) }).click();
  await p.keyboard.press('Escape');
  await sec.locator('[data-el="0"]').evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await sec.locator('[data-el="0"]').click({ position: { x: 2, y: 2 } });
  const third = sec.locator('[data-el="2"]');
  await drag(sec.locator('[data-el="0"] .ed-el-tools .ed-grip'), third, { x: 20, y: (await third.boundingBox()).height - 4 });
  assert.match(await sec.locator('[data-el="2"]').innerText(), /A new heading/, 'the heading is now last');
  assert.match(await sec.locator('[data-el="0"]').innerText(), /Write your text/);
  const next = canvas.locator('.blk-steps').first();
  await drag(sec.locator('[data-el="2"] .ed-el-tools .ed-grip'), next, { x: 30, y: 30 });
  await next.locator('[data-el="0"] .el-heading').waitFor();
  assert.equal(await sec.locator('[data-el]').count(), 2);

  // Layers lists elements under their section; picking one there selects it on the page
  await p.click('.ed-rail button[data-tab="layers"]');
  await p.locator('.layer--el', { hasText: 'Write your text' }).click();
  await sec.locator('[data-el="0"].is-el-selected').waitFor();

  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('element cards in the panel reorder by dragging their grip', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('elements')) { t.skip('the site does not support elements yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  await mockGitHub(ctx);
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  const sec = p.frameLocator('#canvas').locator('.blk-split').first();
  await sec.click({ position: { x: 5, y: 5 } });
  for (const label of ['Heading', 'Text', 'Button']) await p.locator('#inspector .el-add__btn', { hasText: new RegExp(`^${label}$`) }).click();
  await p.keyboard.press('Escape');
  await p.locator('#inspector [data-el-card="2"]').waitFor();
  // Measure once the panel has stopped moving (it re-renders after Escape).
  let grip; let target;
  for (let i = 0; i < 20; i++) {
    const g = await p.locator('#inspector [data-el-card="0"] .el-grip').boundingBox();
    const t = await p.locator('#inspector [data-el-card="1"]').boundingBox(); // a closed card, fully on screen
    if (grip && JSON.stringify([g, t]) === JSON.stringify([grip, target])) break;
    [grip, target] = [g, t];
    await p.waitForTimeout(50);
  }
  await p.mouse.move(grip.x + 5, grip.y + 5);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(grip.x + 5 + ((target.x + 40 - grip.x - 5) * i) / 12, grip.y + 5 + ((target.y + target.height - 4 - grip.y - 5) * i) / 12);
  await p.mouse.up();
  await sec.locator('[data-el="1"]', { hasText: 'A new heading' }).waitFor();
  assert.match(await sec.locator('[data-el="0"]').innerText(), /Write your text/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('add sections between others with +, and new pages from templates', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Consult page' : undefined));
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  const order = () => canvas.locator('main > [data-section-id]').evaluateAll((ns) => ns.map((n) => [...n.classList].find((c) => c.startsWith('blk-'))));

  // + at the top edge of a section adds right above it
  const steps = canvas.locator('.blk-steps').first();
  await steps.hover();
  await steps.locator(':scope > .ed-ins--before').click();
  assert.match(await p.locator('#modal .quick-add > p').first().innerText(), /^Adds between “.+” and “A simple, proven process”/);
  await p.locator('#modal .block-card', { hasText: 'FAQ' }).click();
  const list = await order();
  assert.equal(list[list.indexOf('blk-steps') - 1], 'blk-faq');

  // A page from a template, named after it
  await p.click('.ed-rail button[data-tab="pages"]');
  await p.click('#panel .p-head button:has-text("New")');
  await p.locator('#modal .tpl', { hasText: 'Pricing' }).first().locator('.tpl__main').click();
  assert.equal(await p.inputValue('#modal .new-page__name input'), 'Pricing');
  await p.click('#modal button:has-text("Create page")');
  await canvas.locator('.blk-pricing').waitFor();
  assert.deepEqual(await order(), ['blk-hero', 'blk-pricing', 'blk-faq', 'blk-cta']);
  assert.match(await canvas.locator('.hero__title').first().innerText(), /Pricing/);

  // Save it as a template, then start another page from it
  await p.click('#panel .page-item.is-current button:has-text("Save as template")');
  await p.click('#panel .p-head button:has-text("New")');
  await p.locator('#modal .tpl', { hasText: 'Consult page' }).locator('.tpl__main').click();
  await p.fill('#modal .new-page__name input', 'Plans');
  await p.click('#modal button:has-text("Create page")');
  await canvas.locator('.blk-pricing').waitFor();
  assert.match(await canvas.locator('.hero__title').first().innerText(), /Pricing/, 'the template keeps its content');

  // Copy one of the pages
  await p.click('#panel .p-head button:has-text("New")');
  await p.locator('#modal .tpl', { hasText: 'Services' }).last().locator('.tpl__main').click();
  assert.equal(await p.inputValue('#modal .new-page__name input'), 'Services copy');
  await p.click('#modal button:has-text("Create page")');
  await canvas.locator('.blk-faq').waitFor();

  // An empty page offers its first section
  await p.click('#panel .p-head button:has-text("New")');
  await p.locator('#modal .tpl', { hasText: 'Blank' }).locator('.tpl__main').click();
  await p.fill('#modal .new-page__name input', 'Empty');
  await p.click('#modal button:has-text("Create page")');
  await canvas.locator('.blk-hero').first().click();
  await p.keyboard.press('Delete');
  await canvas.locator('.ed-empty button').click();
  await p.locator('#modal .block-card[title="Heading and paragraph"]').click();
  await canvas.locator('.blk-text').waitFor();

  await publish(p);
  const content = JSON.parse(read('content/site.json'));
  assert.deepEqual(content.pages.slice(-4).map((x) => x.title), ['Pricing', 'Plans', 'Services copy', 'Empty']);
  assert.equal(content.templates[0].name, 'Consult page');
  assert.match(read('pricing/index.html'), /class="sec [^"]*blk-pricing/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('business hours, the call button and the quote form', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('hours')) { t.skip('the site does not support these yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  await p.click('.ed-rail button[data-tab="site"]');

  // Hours: weekdays to start with, then Saturday mornings and longer weekdays
  await p.locator('#panel .f', { hasText: 'Show business hours' }).locator('input').check();
  const footer = canvas.locator('.site-footer__hours');
  await footer.filter({ hasText: 'Mon–Fri 9am–5pm · Sat–Sun closed' }).waitFor();
  const row = (day) => p.locator('#panel .hours-row', { hasText: day });
  await row('Sat').locator('input[type=checkbox]').check();
  await row('Sat').locator('input[type=time]').nth(1).fill('13:00');
  await row('Sat').locator('input[type=time]').nth(1).dispatchEvent('change');
  await row('Mon').locator('input[type=time]').nth(1).fill('18:00');
  await row('Mon').locator('input[type=time]').nth(1).dispatchEvent('change');
  await p.click('#panel button:has-text("Copy Monday to weekdays")');
  await footer.filter({ hasText: 'Mon–Fri 9am–6pm · Sat 9am–1pm · Sun closed' }).waitFor();
  assert.match(await footer.locator('.open-status').innerText(), /^(Open now|Closed)/);
  assert.match(await p.locator('#panel .hours-summary').innerText(), /Mon–Fri 9am–6pm/);

  // Call button: needs a phone number, shown in the Mobile preview
  await p.locator('#panel .f', { hasText: 'Show a “Call now” button' }).locator('input').check();
  await p.locator('#panel .f__help--warn', { hasText: 'Add your phone number' }).waitFor();
  await p.fill('#panel [data-path="phone"]', '(555) 123-4567');
  await p.click('#device-toggle [data-device="mobile"]');
  await canvas.locator('.callbar a[href="tel:5551234567"]').waitFor();
  await p.click('#device-toggle [data-device="desktop"]');
  assert.ok(await canvas.locator('.callbar').isHidden(), 'phones only');

  // Quote form from the Add panel
  await p.click('.ed-rail button[data-tab="add"]');
  await p.click('.block-card:has-text("Quote request")');
  await canvas.locator('.quote__form fieldset.choices').first().waitFor();
  assert.equal(await p.locator('#inspector .list-item').count(), 4, 'four starter questions');

  // Without a login in front, Settings says so and no account is shown
  await p.click('.ed-rail button[data-tab="site"]');
  await p.locator('#panel .login-state', { hasText: 'No login yet' }).waitFor();
  assert.ok(await p.locator('#account').isHidden());

  await publish(p);
  const html = read('index.html');
  assert.match(html, /class="site-footer__hours">Mon–Fri 9am–6pm · Sat 9am–1pm · Sun closed <span class="open-status" data-open-status/);
  assert.match(html, /<div class="callbar callbar--phones"><a class="callbar__btn" href="tel:5551234567">/);
  assert.match(html, /class="contact__form quote__form"/);
  assert.match(html, /"openingHoursSpecification"/);
  const site = JSON.parse(read('content/site.json')).site;
  assert.equal(site.hours.week.sat, '09:00-13:00');
  assert.equal(site.callButton.enabled, true);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('visitor stats and the review page in Settings', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('analytics')) { t.skip('the site does not support these yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  await p.click('.ed-rail button[data-tab="site"]');
  await p.locator('#panel .f', { hasText: 'Count visitors with' }).locator('select').selectOption('goatcounter');
  await p.fill('#panel [data-path="analytics.id"]', 'roe tech');
  await p.locator('#panel .stats-state.f__help--warn', { hasText: 'doesn’t look right' }).waitFor();
  await p.fill('#panel [data-path="analytics.id"]', 'roetech');
  assert.equal(await p.locator('#panel .stats-state a', { hasText: 'View your stats' }).getAttribute('href'), 'https://roetech.goatcounter.com');

  // A review button in Testimonials appears once there is a review page
  await p.fill('#panel [data-path="reviewUrl"]', 'https://g.page/r/abc/review');
  await p.click('.ed-rail button[data-tab="add"]');
  await p.click('.block-card:has-text("Testimonials")');
  await p.locator('#inspector .f', { hasText: 'Show a “Leave a review” button' }).locator('input').check();
  await canvas.locator('.quotes__review a[href="https://g.page/r/abc/review"]').waitFor();

  await publish(p);
  const html = read('index.html');
  assert.match(html, /data-goatcounter="https:\/\/roetech.goatcounter.com\/count"/);
  assert.match(html, /script-src 'self' https:\/\/gc.zgo.at;/);
  assert.match(html, /class="btns quotes__review"/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('checklists and the contents list in posts', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('task-lists')) { t.skip('the site does not support these yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();

  // Pasted checklists keep their tick boxes
  const pasted = await p.evaluate(async () => {
    const m = await import('./assets/js/html-to-md.js');
    return [
      m.htmlToMarkdown('<ul><li><input type="checkbox" checked> Back up</li><li><label><input type="checkbox"> Update</label></li></ul>'),
      m.htmlToMarkdown('<b id="docs-internal-guid-1"><ul><li role="checkbox" aria-checked="true"><p><span>Done</span></p></li><li role="checkbox" aria-checked="false"><p><span>To do</span></p></li></ul></b>'),
    ];
  });
  assert.deepEqual(pasted, ['- [x] Back up\n- [ ] Update', '- [x] Done\n- [ ] To do']);

  await p.click('.ed-rail button[data-tab="blog"]');
  await p.click('button:has-text("New post")');
  const body = p.locator('#panel textarea[data-path="body"]');
  await body.fill('## One\nA\n\n## Two\nB\n\n## Three\n');
  await body.press('End');
  await p.click('#panel .md-tools button[title="Checklist (tick boxes)"]');
  await p.keyboard.type('Change the router password');
  assert.match(await body.inputValue(), /## Three\n- \[ \] Change the router password$/);
  await canvas.locator('.post__body .task', { hasText: 'Change the router password' }).locator('input[type=checkbox]').waitFor();
  await canvas.locator('.post__toc a[href="#two"]').waitFor();
  const toc = p.locator('#panel [data-path="toc"]');
  assert.ok(await toc.isChecked(), 'on by default');
  await toc.uncheck();
  await canvas.locator('.post__toc').waitFor({ state: 'detached' });
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('blog tab: filter drafts, find an entry, word count and last updated date', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('post-updated')) { t.skip('the site does not support these yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  // More than six entries, so the find box appears, and one draft
  await p.click('.ed-rail button[data-tab="blog"]');
  for (let i = 0; i < 7; i++) await p.click('button:has-text("New post")').then(() => p.click('#panel .p-head button[title="Back to all entries"]'));
  await p.click('#panel .post-row >> nth=0');
  await p.locator('#panel .f', { hasText: 'Show on website' }).locator('input').uncheck();
  await p.fill('#panel [data-path="title"]', 'Passkeys for the office');
  await p.click('#panel .p-head button[title="Back to all entries"]');

  const rows = p.locator('#panel .post-row');
  const all = await rows.count();
  await p.click('#panel .blog-filter button[data-show="draft"]');
  const drafts = await rows.count();
  assert.ok(drafts >= 1 && drafts < all);
  assert.equal(await p.locator('#panel .post-row .badge', { hasText: 'Draft' }).count(), drafts, 'only drafts are listed');
  await p.locator('#panel .p-hint', { hasText: 'Drafts aren’t on your website' }).waitFor();
  await p.click('#panel .blog-filter button[data-show="all"]');
  await p.fill('#panel .blog-find', 'passkeys for');
  assert.equal(await rows.count(), 1);
  await rows.first().click();

  // Word count under the article, and the last updated date on the page
  await p.fill('#panel textarea[data-path="body"]', Array(450).fill('word').join(' '));
  assert.equal(await p.locator('#panel .md-count').innerText(), '450 words · about 2 min read');
  await p.fill('#panel [data-path="date"]', '2026-01-05');
  await p.fill('#panel [data-path="updated"]', '2026-02-10');
  await canvas.locator('.post-meta__updated', { hasText: 'Updated Feb 10, 2026' }).waitFor();
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('what’s new: a note on first visit, the list in Help, then quiet', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await newPage(ctx, { news: true });
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  const note = p.locator('.toast', { hasText: 'New in the editor: jump to anything' });
  await note.waitFor();
  assert.ok(await p.locator('.ed-rail [data-tab="help"] .ed-rail__dot').isVisible());
  await note.locator('button', { hasText: 'See what’s new' }).click();
  await p.locator('#panel .news__item.is-new', { hasText: 'Jump to anything' }).waitFor();
  assert.equal(await p.locator('#panel .news__item.is-new', { hasText: 'Drag and drop' }).count(), 0, 'earlier features are not marked new');
  assert.equal(await p.locator('.ed-rail [data-tab="help"] .ed-rail__dot').count(), 0);
  await p.locator('#panel .news__item', { hasText: 'Jump to anything' }).locator('button', { hasText: 'Show me' }).click();
  await p.locator('.palette__in').waitFor();
  await p.keyboard.press('Escape');
  await p.reload({ waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  await p.waitForTimeout(500);
  assert.equal(await p.locator('.toast', { hasText: 'New in the editor' }).count(), 0, 'shown once');
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('jump to anything with Ctrl+K', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await mockGitHub(ctx);
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();

  // A page, by typing part of its name, then Enter
  await p.keyboard.press('Control+k');
  const box = p.locator('.palette__in');
  await box.waitFor();
  assert.ok(await p.locator('.palette__item').count() > 5, 'actions, pages and panels before typing');
  await box.fill('abou');
  assert.equal(await p.locator('.palette__item.is-active strong').innerText(), 'About');
  await p.keyboard.press('Enter');
  assert.equal(await p.locator('#page-select').inputValue(), String((await p.locator('#page-select option').allInnerTexts()).findIndex((t) => /About/.test(t))));
  assert.ok(await p.locator('#modal').isHidden());

  // A setting, from inside text on the canvas
  await canvas.locator('.hero__title').first().click();
  await p.keyboard.press('Control+k');
  await box.fill('announcement');
  await p.locator('.palette__item', { hasText: 'Announcement bar' }).click();
  assert.equal(await p.locator('.ed-rail button.is-on').getAttribute('data-tab'), 'site');
  await p.locator('#panel .p-sub', { hasText: 'Announcement bar' }).waitFor();

  // Arrow keys move through results; nothing found says so
  await p.click('#jump');
  await box.fill('zzzz qqqq');
  await p.locator('.palette__none', { hasText: 'Nothing found' }).waitFor();
  await box.fill('new');
  const first = await p.locator('.palette__item.is-active strong').innerText();
  await p.keyboard.press('ArrowDown');
  assert.notEqual(await p.locator('.palette__item.is-active strong').innerText(), first);
  await p.keyboard.press('Escape');
  assert.ok(await p.locator('#modal').isHidden());

  // A blog post
  await p.keyboard.press('Control+k');
  await box.fill('multi-factor');
  await p.locator('.palette__item', { hasText: /Post ·/ }).first().click();
  await p.locator('#panel [data-path="slug"]').waitFor();
  assert.match(await p.locator('#panel [data-path="slug"]').inputValue(), /multi-factor/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('announcement dates and the page-not-found wording in Settings', async (t) => {
  const theme = await import(pathToFileURL(join(SITE_DIR, 'assets/js/theme-api.js')).href);
  if (!theme.FEATURES?.includes('not-found')) { t.skip('the site does not support these yet'); return; }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const { read } = await mockGitHub(ctx);
  const p = await newPage(ctx);
  p.on('dialog', (d) => d.accept());
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  const canvas = p.frameLocator('#canvas');
  await canvas.locator('.hero__title').first().waitFor();
  await p.click('.ed-rail button[data-tab="site"]');
  await p.locator('#panel .f', { hasText: 'Show a bar above the header' }).locator('input').check();
  await p.fill('#panel [data-path="announcement.text"]', 'Closed for the holidays');
  await p.fill('#panel [data-path="announcement.start"]', '2999-12-24');
  await p.fill('#panel [data-path="announcement.end"]', '2999-12-26');
  await p.locator('#panel .ann-when', { hasText: 'Visitors see it from Dec 24, 2999 through Dec 26, 2999.' }).waitFor();
  await canvas.locator('.announce.is-off .announce__note', { hasText: 'Starts Dec 24, 2999' }).waitFor();
  await p.fill('#panel [data-path="announcement.end"]', '2999-12-01');
  await p.locator('#panel .ann-when.f__help--warn', { hasText: 'never shows' }).waitFor();
  await p.fill('#panel [data-path="announcement.end"]', '2999-12-26');

  // Page not found: empty boxes show the standard wording as a hint
  assert.equal(await p.getAttribute('#panel [data-path="notFound.heading"]', 'placeholder'), theme.NOT_FOUND.heading);
  assert.ok(await p.locator('#panel [data-path="notFound.links"]').isChecked(), 'page links are on by default');
  await p.fill('#panel [data-path="notFound.heading"]', 'Oops, that page moved');
  await p.locator('#panel [data-path="notFound.links"]').uncheck();
  const [preview] = await Promise.all([ctx.waitForEvent('page'), p.click('#panel button:has-text("Preview the page")')]);
  await preview.locator('h1', { hasText: 'Oops, that page moved' }).waitFor();
  assert.equal(await preview.locator('.notfound__links').count(), 0);
  await preview.close();

  await publish(p);
  const nf = read('404.html');
  assert.match(nf, /<h1 class="sec-title">Oops, that page moved<\/h1>/);
  assert.doesNotMatch(nf, /notfound__links/);
  assert.match(read('index.html'), /<div class="announce" data-start="2999-12-24" data-end="2999-12-26" hidden>/);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('behind a login, the editor shows who is signed in', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.route('**/cdn-cgi/access/get-identity', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email: 'owner@example.com', name: 'Owner' }) }));
  const p = await newPage(ctx);
  await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
  await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
  await p.locator('#account').waitFor();
  assert.equal(await p.locator('#account .ed-account__btn').innerText(), 'O');
  await p.click('#account .ed-account__btn');
  assert.equal(await p.locator('#account .ed-account__email').innerText(), 'owner@example.com');
  assert.equal(await p.locator('#account a', { hasText: 'Sign out' }).getAttribute('href'), '/cdn-cgi/access/logout');
  await p.click('.ed-rail button[data-tab="site"]');
  await p.locator('#panel .login-state.is-on', { hasText: 'Signed in as owner@example.com' }).waitFor();
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

test('connection problems are explained in plain words and never change the site', async () => {
  for (const [token, expected, fix] of [
    ['ok', /Connected to .* as site-owner\. Publishing will work/, null],
    ['bad', /does not accept this access token/, /expired/],
    ['read-only', /can read the repository but is not allowed to save/, /Contents to “Read and write”/],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const gh = await mockGitHub(ctx, { token });
    const p = await newPage(ctx);
    p.on('dialog', (d) => d.accept());
    await p.goto(`${editorUrl}/`, { waitUntil: 'load' });
    await p.frameLocator('#canvas').locator('.hero__title').first().waitFor();
    await p.click('#publish');
    await p.fill('.ed-modal input[type=password]', 'github_pat_TEST');
    await p.click('button:has-text("Test connection")');
    await p.locator('.log div', { hasText: expected }).waitFor();
    if (fix) assert.match(await p.locator('.log').innerText(), fix);
    if (token === 'read-only') {
      // A failed publish says the live site is untouched and runs the same check.
      await p.click('button:has-text("Publish now")');
      await p.locator('.log div', { hasText: 'Your live site was not changed' }).waitFor();
      await p.locator('.log div', { hasText: expected }).waitFor();
      assert.equal(gh.refs.length, 0);
    }
    assert.deepEqual(p.errors.filter((e) => !/40[13]/.test(e)), []);
    await ctx.close();
  }
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
