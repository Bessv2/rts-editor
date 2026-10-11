# Site Editor for Roe Technology Services

A standalone visual editor for **roetechnologyservices.com**, published at
**https://editor.roetechnologyservices.com**.

Click text to type, add and arrange sections, write blog posts, manage images, then press
**Publish**. The editor saves your content and every built page to the site's repository
([Bessv2/RTS](https://github.com/Bessv2/RTS)) in a single commit, and GitHub Pages puts it live
about a minute later.

## How it fits together

```
editor.roetechnologyservices.com          roetechnologyservices.com
(this repo, Bessv2/rts-editor)            (Bessv2/RTS)
┌──────────────────────────┐   loads      ┌──────────────────────────────────┐
│ editing UI, drafts,      │ ───────────► │ assets/js/theme-api.js           │
│ history, image library,  │   theme      │ (sections, renderer, page builder│
│ publish                  │              │  styles: assets/css/site.css)    │
└──────────┬───────────────┘              └──────────────────────────────────┘
           │ GitHub API (your token)                      ▲
           └──────────► commits content + pages ──────────┘ GitHub Pages
```

- **The site owns how things look.** Sections, styles and the page builder live in the site repo
  and are exposed through one versioned file, `theme-api.js`. The editor loads it from the live
  site, so it always previews and publishes with exactly the code that is live.
- **The editor owns editing.** It holds no content and no secrets. Your GitHub token stays in your
  browser and is only sent to `api.github.com`.
- **Versioned contract.** `theme-api.js` exports `EDITOR_API`. If the site ever changes that
  contract, the editor shows a clear message instead of corrupting content. CI re-tests the
  editor against the live site's code every week.
- **Optional features follow the site.** Newer site options (unpublished pages, "Hide from
  search engines", redirects) appear in the editor only when the site's `theme-api.js` lists them
  in `FEATURES`, so the editor keeps working with an older site.

### Page options

- **Show on website** (Pages tab) takes a page off the site, or keeps a new one off until it is
  ready, while you keep editing it. Hidden from visitors, but not secret: the site's repository
  is public.
- **Hide from search engines** keeps a page on the site but asks Google and others not to list it.
- **Renamed pages keep working.** When you change the address of a page or post that is already
  live, the old address forwards to the new one. Redirects are listed in Settings → Redirects,
  where you can also add or remove them by hand.

## One-time setup

1. **GitHub Pages** for this repo: *Settings → Pages → Build and deployment →* Source:
   **Deploy from a branch**, Branch: **main** / **(root)**. Save.
2. **DNS**: at your domain registrar add a **CNAME** record: name `editor`, value
   `bessv2.github.io`. Then in *Settings → Pages* set the custom domain to
   `editor.roetechnologyservices.com` (it reads the `CNAME` file) and tick **Enforce HTTPS** once
   it is offered.
3. **Publishing token**: open the editor, press Publish, and paste a fine-grained token with
   access to **Bessv2/RTS** only and **Contents: Read and write**. Tick "Remember token" only on
   your own computer. The editor lives on its own address, so the browser asks for the token
   (and keeps drafts) separately from the old built-in editor.

DNS changes can take a few minutes to an hour, and GitHub then issues the HTTPS certificate
automatically. Until then, keep using the built-in editor at roetechnologyservices.com/editor.html.

## Security

- The Content Security Policy only allows scripts from the editor itself and the configured site,
  so a crafted link cannot load foreign code into the page that holds your token.
- The editor refuses to run inside another website's frame (clickjacking protection).
- Content is validated before publishing, and the page cleanup on publish can only remove
  generated page files.

## Pointing the editor at a site

Everything about the connected site is in `editor.config.json`:

```json
{
  "siteUrl": "https://roetechnologyservices.com",
  "repo": { "owner": "Bessv2", "name": "RTS", "branch": "main" },
  "editorDomain": "editor.roetechnologyservices.com"
}
```

After changing it, run `npm run configure`. That regenerates `assets/js/site-config.js`, the
security policy in `index.html`/`preview.html` and `CNAME`. Any site that serves a compatible
`assets/js/theme-api.js` (over https, from GitHub Pages or any host with CORS enabled) can be
edited this way.

## Development

Requirements: Node.js 20 or newer. No dependencies.

```sh
npm run check        # generated config is in sync with editor.config.json
npm test             # unit tests
npm run serve        # http://localhost:8081 (loads the theme from the live site)
```

Browser tests run the editor and a local copy of the site on two different origins, exactly
like production:

```sh
git clone https://github.com/Bessv2/RTS site
npm install --no-save playwright && npx playwright install chromium
SITE_DIR=site npm run test:e2e
```

| Path | Purpose |
| --- | --- |
| `index.html`, `assets/js/editor.js` | The editor |
| `assets/js/config.js`, `assets/js/site-config.js` | Connected site and theme loading |
| `assets/js/publish.js` | GitHub: publish in one commit, version history, cloud drafts |
| `assets/js/store.js` | Drafts and saved versions in the browser (IndexedDB) |
| `preview.html`, `assets/js/preview.js` | Preview of unpublished drafts |
| `scripts/configure.mjs` | Applies `editor.config.json` |
