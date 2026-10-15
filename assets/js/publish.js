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
      const err = new Error(`${json.message || res.statusText}${hint}`);
      err.status = res.status;
      throw err;
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
  log('Preparing content…');
  const { out, files } = await extractImages(doc);
  log(`Connecting to ${owner}/${repo} (${branch})…`);
  const head = await api(`/git/ref/heads/${encPath(branch)}`);
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
  // Reading a branch is /git/ref/…, moving it is /git/refs/… (GitHub answers 404 to a PATCH on the singular form).
  await api(`/git/refs/heads/${encPath(branch)}`, { method: 'PATCH', body: { sha: commit.sha } });
  log(`Committed ${commit.sha.slice(0, 7)}.`, 'ok');
  return { commitUrl: commit.html_url, published: out, contentSha: content.sha };
}

// Checks, in order, everything publishing needs and explains the first thing
// that is missing in plain words. Only reads, apart from saving one empty file
// object (git keeps a single copy of it and it never appears in the site).
// Returns { ok, message, fix }.
export async function checkAccess({ owner, repo, branch, token }) {
  const at = (path, opts) => fetch(`https://api.github.com${path}`, {
    cache: 'no-store',
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const r = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const classic = /^gh[pousr]_/.test(token);
  const fail = (message, fix) => ({ ok: false, message, fix });
  let res;
  try { res = await at('/user'); } catch { return fail('Could not reach GitHub.', 'Check your internet connection and try again.'); }
  if (res.status === 401) return fail('GitHub does not accept this access token.', 'It may be mistyped, expired or deleted. Create a new token and paste it again.');
  if (!res.ok) return fail(`GitHub answered ${res.status} when checking the token.`, 'Try again in a minute.');
  const user = (await res.json().catch(() => ({}))).login || '';
  res = await at(r);
  if (res.status === 404 || res.status === 403) {
    return fail(`Repository ${owner}/${repo} was not found${user ? ` for ${user}` : ''}.`,
      'Check the Owner and Repository boxes match the address github.com/OWNER/REPOSITORY, and that the token was given access to it.');
  }
  if (!res.ok) return fail(`GitHub answered ${res.status} when opening ${owner}/${repo}.`, 'Try again in a minute.');
  res = await at(`${r}/branches/${encPath(branch)}`);
  if (res.status === 404) return fail(`Branch “${branch}” does not exist in ${owner}/${repo}.`, 'The Branch box is usually “main”. Use the branch GitHub Pages publishes from.');
  if (!res.ok) return fail(`GitHub answered ${res.status} when opening branch ${branch}.`, 'Try again in a minute.');
  res = await at(`${r}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: '', encoding: 'utf-8' }) });
  if (res.status === 403 || res.status === 404) {
    return fail('The token can read the repository but is not allowed to save to it.', classic
      ? 'This is a classic token: it needs the “repo” scope (or “public_repo” for a public repository). Or create a fine-grained token as described above.'
      : `Edit the token on GitHub: under Repository access include ${repo}, and under Permissions → Repository permissions set Contents to “Read and write”. Organization-owned repositories may also need the owner to approve the token.`);
  }
  // 422 (GitHub refusing the empty test file) is only reported after permissions were checked.
  if (!res.ok && res.status !== 422) return fail(`GitHub answered ${res.status} when testing saving.`, 'Try again in a minute.');
  return { ok: true, message: `Connected to ${owner}/${repo} (${branch})${user ? ` as ${user}` : ''}. Publishing will work.` };
}

// True when the site's code (assets/js) changed on the branch after `since`,
// i.e. this editor tab may be building pages with an older copy of it.
export async function codeChangedSince(cfg, since) {
  const api = createApi(cfg);
  const list = await api(`/commits?sha=${encodeURIComponent(cfg.branch)}&path=assets/js&since=${since.toISOString()}&per_page=1`, { allow404: true });
  return Array.isArray(list) && list.length > 0;
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
