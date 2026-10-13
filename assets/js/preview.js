// Shows the editor's unpublished draft exactly as the site would render it:
// preview.html?path=/services/ . Uses the site's own theme and stylesheet.
import { SITE, loadTheme, showFatal } from './config.js';
import { kv } from './store.js';

let theme;
try { theme = await loadTheme(); } catch (err) { showFatal(err.message); throw err; }
const { migrate, findRoute, renderPage, renderPostPage, renderNotFound, postTitle, themeCSS, fontsHref, enhance } = theme;

// Site-relative images and links resolve against the live site. (The site's
// stylesheet is linked in preview.html, before the theme variables set below.)
const base = document.createElement('base');
base.href = `${SITE}/`;
document.head.prepend(base);

async function loadDraft() {
  try {
    const draft = await kv.get('draft');
    if (draft?.json) return migrate(JSON.parse(draft.json));
  } catch { /* fall back to the published content */ }
  const res = await fetch(`${SITE}/content/site.json?v=${Date.now()}`, { cache: 'no-store' });
  return migrate(await res.json());
}

const app = document.getElementById('app');
const doc = await loadDraft().catch((err) => { app.textContent = `Could not load the preview: ${err.message}`; throw err; });
document.getElementById('theme-vars').textContent = themeCSS(doc.theme);
const fonts = fontsHref(doc.theme);
if (fonts) document.getElementById('theme-fonts').setAttribute('href', fonts);

// Absolute URL: the <base> above points at the site, but history must stay on the editor's origin.
const editorUrl = (path) => `${location.origin}${location.pathname}?path=${encodeURIComponent(path)}`;
function show(path, push = false, hops = 0) {
  // Unpublished pages and posts can be previewed too; redirects are followed like the live site would.
  const route = findRoute(doc, path, { drafts: true });
  if (route?.type === 'redirect' && route.to.startsWith('/') && hops < 5) { show(route.to, push, hops + 1); return; }
  if (route?.type === 'redirect') { location.href = route.to; return; }
  if (route?.type === 'post') {
    app.innerHTML = renderPostPage(doc, route.post);
    document.title = `Preview: ${postTitle(route.post)}`;
  } else if (route?.type === 'page') {
    app.innerHTML = renderPage(doc, route.index);
    document.title = `Preview: ${doc.pages[route.index].title}`;
  } else {
    app.innerHTML = renderNotFound(doc);
    document.title = 'Preview: page not found';
  }
  if (push) history.pushState({ path }, '', editorUrl(path));
  enhance(app, { preview: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// Keep site links inside the preview. The <base> points at the live site, so
// in-page #links (and the skip link) are handled here too; files such as
// images, the gallery lightbox and feed.xml are left alone.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('data-lightbox')) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    e.preventDefault();
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
    return;
  }
  if (!href.startsWith('/') || href.startsWith('//')) return;
  const [path, hash] = href.split('#');
  if (/\.[a-z0-9]{2,5}$/i.test(path.split('?')[0])) return;
  e.preventDefault();
  show(path || '/', true);
  if (hash) document.getElementById(hash)?.scrollIntoView();
});
addEventListener('popstate', () => show(new URLSearchParams(location.search).get('path') || '/'));

const badge = document.createElement('div');
badge.className = 'preview-badge';
badge.textContent = 'Preview — not published yet';
document.body.append(badge);
show(new URLSearchParams(location.search).get('path') || '/');
