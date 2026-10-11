import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImages } from '../../assets/js/publish.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('uploaded images become files and are removed from the content', async () => {
  const doc = { site: { logo: png }, posts: [{ body: `Look: ![](${png}) nice` }], media: [{ src: png }] };
  const { out, files } = await extractImages(doc);
  assert.equal(files.size, 1, 'the same image is stored once');
  const [path] = files.keys();
  assert.match(path, /^assets\/uploads\/[0-9a-f]{16}\.png$/);
  assert.equal(out.site.logo, path);
  assert.equal(out.posts[0].body, `Look: ![](${path}) nice`);
  assert.equal(out.media[0].src, path);
  assert.ok(!JSON.stringify(out).includes('data:image'));
  assert.equal(doc.site.logo, png, 'the editor copy keeps the original');
});
