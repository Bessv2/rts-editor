// GitHub integration for the editor: publishing, version history and cloud drafts.
// Everything goes through the REST API with the user's fine-grained token.

const enc = new TextEncoder();
const DRAFT_BRANCH = 'editor-drafts';
const DRAFT_PATH = 'draft.json';

function utf8ToBase64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// The id git gives a file's contents (the same "sha" the GitHub API reports),
// so the editor can tell which published version a draft started from.
export async function gitBlobSha(text) {
  const body = enc.encode(text);
  const head = enc.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const buf = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class PublishCancelled extends Error {}

async function hashOf(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export function createApi({ owner, repo, token }) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return async function api(path, { method = 'GET', body, raw = false, allow404 = false } = {}) {
    const res = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && res.status === 404) return null;
    if (raw && res.ok) return res.text();
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 401 ? ' (check your token)'
        : res.status === 403 ? ' (the token needs Contents: Read and write on this repository)'
        : res.status === 404 ? ' (check repository, branch and token permissions)'
        : res.status === 409 || res.status === 422 ? ' (the branch changed, try again)' : '';
      throw new Error(`${json.message || res.statusText}${hint}`);
    }
    return json;
  };
}

// Replace every data:image URL in the document (whole values, or images
// embedded in post text) with a repo path; collect the files to upload.
export async function extractImages(doc) {
  const files = new Map();
  async function toPath(dataUrl) {
    const m = dataUrl.match(/^data:(image\/[\w+.-]+)(;base64)?,(.*)$/s);
    if (!m || !EXT[m[1]]) return null;
    const path = `assets/uploads/${await hashOf(dataUrl)}.${EXT[m[1]]}`;
    if (!files.has(path)) files.set(path, m[2] ? m[3] : utf8ToBase64(decodeURIComponent(m[3])));
    return path;
  }
  async function walk(node) {
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = await walk(node[i]); return node; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) node[k] = await walk(node[k]); return node; }
    if (typeof node !== 'string' || !node.includes('data:image/')) return node;
    if (node.startsWith('data:image/')) return (await toPath(node)) ?? node;
    let out = node;
    for (const m of new Set(node.match(/data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=]+/g) || [])) {
      const path = await toPath(m);
      if (path) out = out.split(m).join(path);
    }
    return out;
  }
  const out = await walk(structuredClone(doc));
  return { out, files };
}

// Publishes in a single commit: content/site.json, uploaded images, and every
// generated page (build.js). Pages that no longer exist are deleted.
// buildSite/staleFiles come from the site's theme (theme-api.js), so pages are
// always built by the code that is live on the site.
// base is the content/site.json sha the draft started from. If the repository
// has a different one (published from another computer or by hand),
// confirmOverwrite() decides whether to replace it.
export async function publishToGitHub({ owner, repo, branch, token, message, doc, origin, buildSite, staleFiles, base, confirmOverwrite, log = () => {} }) {
  const api = createApi({ owner, repo, token });
  const ref = `/git/ref/heads/${encPath(branch)}`;
  log('Preparing content…');
  const { out, files } = await extractImages(doc);
  log(`Connecting to ${owner}/${repo} (${branch})…`);
  const head = await api(ref);
  const parent = await api(`/git/commits/${head.object.sha}`);
  if (base && confirmOverwrite) {
    const current = await api(`/contents/content/site.json?ref=${head.object.sha}`, { allow404: true });
    if (current?.sha && current.sha !== base && !(await confirmOverwrite())) throw new PublishCancelled('Publishing cancelled. Nothing was changed.');
  }
  const upload = async (path, content, encoding = 'utf8') => {
    const blob = await api('/git/blobs', { method: 'POST', body: encoding === 'base64' ? { content, encoding } : { content: utf8ToBase64(content), encoding: 'base64' } });
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  };

  const tree = [];
  for (const [path, b64] of files) {
    log(`Uploading ${path}…`);
    tree.push(await upload(path, b64, 'base64'));
  }
  log('Saving content…');
  const content = await upload('content/site.json', `${JSON.stringify(out, null, 2)}\n`);
  tree.push(content);

  log('Building pages…');
  const site = buildSite(out, { origin });
  for (const [path, content] of site.files) tree.push(await upload(path, content));
  const previous = await api(`/contents/generated.json?ref=${encodeURIComponent(branch)}`, { raw: true, allow404: true });
  for (const path of staleFiles(previous, site.paths)) {
    log(`Removing old page ${path}…`);
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
  }
  log(`${site.files.size} files built.`);

  const newTree = await api('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
  if (newTree.sha === parent.tree.sha) { log('No changes since the last publish.', 'ok'); return { unchanged: true, published: out, contentSha: content.sha }; }
  const commit = await api('/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [head.object.sha] } });
  await api(ref, { method: 'PATCH', body: { sha: commit.sha } });
  log(`Committed ${commit.sha.slice(0, 7)}.`, 'ok');
  return { commitUrl: commit.html_url, published: out, contentSha: content.sha };
}

// Past published versions of the site content.
export async function listPublishedVersions(cfg, limit = 25) {
  const api = createApi(cfg);
  const list = await api(`/commits?path=content/site.json&sha=${encodeURIComponent(cfg.branch)}&per_page=${limit}`);
  return list.map((c) => ({ sha: c.sha, message: c.commit.message.split('\n')[0], date: c.commit.author?.date || c.commit.committer?.date, url: c.html_url }));
}

export async function readPublishedVersion(cfg, sha) {
  const api = createApi(cfg);
  return JSON.parse(await api(`/contents/content/site.json?ref=${encodeURIComponent(sha)}`, { raw: true }));
}

// Cloud drafts live on their own branch so they never affect the live site.
export async function saveCloudDraft(cfg, doc) {
  const api = createApi(cfg);
  const exists = await api(`/git/ref/heads/${DRAFT_BRANCH}`, { allow404: true });
  if (!exists) {
    const head = await api(`/git/ref/heads/${encPath(cfg.branch)}`);
    await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${DRAFT_BRANCH}`, sha: head.object.sha } });
  }
  const current = await api(`/contents/${DRAFT_PATH}?ref=${DRAFT_BRANCH}`, { allow404: true });
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), doc });
  await api(`/contents/${DRAFT_PATH}`, { method: 'PUT', body: {
    message: 'Save editor draft', branch: DRAFT_BRANCH, content: utf8ToBase64(payload), ...(current?.sha ? { sha: current.sha } : {}),
  } });
}

export async function loadCloudDraft(cfg) {
  const api = createApi(cfg);
  const text = await api(`/contents/${DRAFT_PATH}?ref=${DRAFT_BRANCH}`, { raw: true, allow404: true });
  return text ? JSON.parse(text) : null;
}
