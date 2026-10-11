// Connects the editor to the site it edits. The site is described in
// site-config.js (generated from editor.config.json by scripts/configure.mjs).
// The site's theme (sections, renderer, page builder) is loaded from the live
// site at runtime, so editing and publishing always use the site's own code.
import { CONFIG } from './site-config.js';

export { CONFIG };
export const SITE = CONFIG.siteUrl.replace(/\/+$/, '');
export const SUPPORTED_API = [1];

export class ThemeError extends Error {}

export async function loadTheme(siteUrl = SITE) {
  let api;
  try {
    api = await import(`${siteUrl}/assets/js/theme-api.js`);
  } catch (err) {
    throw new ThemeError(`The editor couldn’t load your site’s theme from ${siteUrl}. Check your internet connection and that the site is online, then reload. (${err.message})`);
  }
  if (!SUPPORTED_API.includes(api.EDITOR_API)) {
    throw new ThemeError(`Your site uses theme version ${api.EDITOR_API}, but this editor supports version ${SUPPORTED_API.join(', ')}. Update the editor (Bessv2/rts-editor) to a matching version.`);
  }
  return api;
}

// Full-screen message when the editor can't start.
export function showFatal(message) {
  document.body.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'ed-fatal';
  const h = document.createElement('h1');
  h.textContent = 'The editor couldn’t start';
  const p = document.createElement('p');
  p.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'ed-btn ed-btn--primary';
  btn.textContent = 'Try again';
  btn.addEventListener('click', () => location.reload());
  box.append(h, p, btn);
  document.body.append(box);
}

// Site files (images, uploads, library) live on the site, not the editor.
export function siteAsset(src, safeSrc) {
  const v = safeSrc(src);
  if (!v || v.startsWith('data:') || /^https?:\/\//i.test(v)) return v;
  return `${SITE}${v.startsWith('/') ? '' : '/'}${v}`;
}
