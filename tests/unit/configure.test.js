import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { CONFIG } from '../../assets/js/site-config.js';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(await readFile(new URL('editor.config.json', root), 'utf8'));

test('generated files match editor.config.json', () => {
  execFileSync(process.execPath, [new URL('scripts/configure.mjs', root).pathname, '--check'], { stdio: 'pipe' });
  assert.equal(CONFIG.siteUrl, new URL(config.siteUrl).origin);
  assert.deepEqual(CONFIG.repo, { branch: 'main', ...config.repo });
});

test('scripts may only come from the editor and the configured site', async () => {
  for (const file of ['index.html', 'preview.html']) {
    const html = await readFile(new URL(file, root), 'utf8');
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    assert.equal(scriptSrc, `script-src 'self' ${CONFIG.siteUrl}`, file);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
  }
});

test('the site address must be https (except localhost for testing)', () => {
  assert.throws(() => execFileSync(process.execPath, [new URL('scripts/configure.mjs', root).pathname, '--site', 'http://evil.example', '--out', '/tmp'], { stdio: 'pipe' }));
});
