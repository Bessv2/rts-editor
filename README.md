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
  editor against the live site's code every week. (GitHub pauses scheduled runs in a repository
  with no activity for 60 days; turn it back on under Actions → CI if that happens.)
- **Optional features follow the site.** Newer site options (unpublished pages, "Hide from
  search engines", redirects) appear in the editor only when the site's `theme-api.js` lists them
  in `FEATURES`, so the editor keeps working with an older site.

### Checkup

The **Checkup** tab runs the site's own checks (`audit.js` in the site repo) as you work. It finds
broken links, buttons without links, pages without a main headline, leftover sample text
(underlined on the page), missing search descriptions, a contact form with nowhere to send
messages, and more. Each item has a **Show me** button that jumps to the right page, section or
setting. The Publish window lists anything worth fixing; problems marked “Must fix” block
publishing until they are fixed.

### More options

- **Visitor stats** (Settings): count visitors with Cloudflare Web Analytics or GoatCounter (free,
  no cookies); paste the token or code and use **View your stats**. **Review page** (Settings →
  Business): your Google review link, used by the “Leave a review” button in Testimonials and the
  **Review button** element. **Resource links** (Add panel): cards of helpful links grouped by topic.
- **Business hours** (Settings): tick the days you're open and set the times; the Contact section,
  the footer and the **Opening hours** element show them with “Open now”, worked out for your
  time zone. **Call button** (Settings): a “Call now” (and “Text us”) button that floats at the
  bottom of phones, or every screen. **Quote request** (Add panel): a form with your own
  questions.
- **Elements**: add a heading, text, image, button, line or space to any section (the
  Elements group in the section panel, or the **+** in the section toolbar). Click an element on
  the page to edit it; its small toolbar moves, duplicates and removes it (Delete and Ctrl+D work
  too). Give elements a width (½, ⅓, ⅔) to put them side by side. **Empty section** in the Add
  panel starts with nothing but elements.
- **Add between sections**: hover a section and press the **+** at its top or bottom edge.
- **Page templates**: Pages → New offers ready-made pages (services, pricing, booking, team,
  FAQ, text page and more), any of your own pages to copy, and pages you saved with **Save as
  template**.
- **Link picker**: the **Choose** button next to every button and link (and the Link button
  when writing) lists your pages, the sections on each page, blog posts, your email and phone,
  with a search box, or takes a web address (`example.com` becomes `https://example.com`).
  Picking a section that has no anchor gives it one from its heading.
- **Booking calendar** (section): paste a Calendly, Microsoft Bookings, Google Calendar
  appointment page, Cal.com, HubSpot or Acuity link. The editor shows a placeholder; Preview and
  the live site show the calendar. Other booking links become a button.
- **Section names**: give any section a name only you see (“Spring promo”). Layers and the page
  use it, so sections are easy to tell apart.
- **Show on**: in Section style, show a section on all devices, computers only or phones only.
- **Search and share preview**: the Pages tab shows how each page may look on Google and when
  its link is shared, and each page can have its own share image.
- **Search engines** (Settings): site language, plus the Google Search Console and Bing Webmaster
  Tools codes (paste the code or the whole `<meta>` tag).
- **Scheduled posts**: give a post a future date and it is marked “Scheduled”. It goes live on
  that day by itself, because the site rebuilds every morning.
- **Image descriptions**, the **message after sending** for the contact form, and a **contrast
  check** in Checkup for colors that are hard to read.

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
   (and keeps drafts) separately from the old built-in editor. **Test connection** in the same
   window checks the token, repository, branch and permission one by one and says what to change
   if something is missing; it also runs on its own when a publish is refused.

DNS changes can take a few minutes to an hour, and GitHub then issues the HTTPS certificate
automatically.

**Moving from the old built-in editor:** the old editor has been retired. Drafts and saved
tokens don't carry over, because the editor now lives on its own address. If you used the old
editor, open roetechnologyservices.com/editor.html in the same browser: it offers to download any
unpublished draft or saved version it left there. Then use Settings → Backup → Restore from file
here.

## Editor login

Nobody can change the site without your GitHub token, but anyone who finds the editor's address
can open it. To hide it completely, put it behind **Cloudflare Access** (free for up to 50
people): visitors to `editor.roetechnologyservices.com` first see a sign-in page, and only the
accounts you allow get through. You can sign in with **Google** or with a **one-time code sent
to any email address**, such as your Zoho address. Once it is set up, the editor shows your account
in the top right corner (with **Sign out**) and Settings → Editor login says it is protected.

The public site is not affected: only the editor's address gets the login.

**1. Move the domain's DNS to Cloudflare** (skip if it is already there)
1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com), choose
   **Add a domain**, enter `roetechnologyservices.com` and pick the **Free** plan.
2. Cloudflare copies your current DNS records. **Before going on, compare them with your
   current DNS provider** and add anything missing, above all your **Zoho Mail records**
   (the `MX` records `mx.zoho.com`, `mx2.zoho.com`, `mx3.zoho.com`, the `TXT` record with
   `v=spf1 include:zoho.com`, the `zmail._domainkey` DKIM record and any verification `TXT`).
   If these are missing, email stops arriving.
3. Set every record to **DNS only** (grey cloud) **except** `editor`, which must be **Proxied**
   (orange cloud). The GitHub Pages records stay as they are: `A` records to
   `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` and `CNAME`s for `www` and `editor` to
   `bessv2.github.io`.
4. At the company where you bought the domain, replace the nameservers with the two Cloudflare
   shows. Cloudflare emails you when the domain is active (minutes to a few hours).
5. In Cloudflare, **SSL/TLS → Overview**: choose **Full** (not Flexible, which causes endless
   redirects with GitHub Pages).

**2. Turn on the login**
1. In Cloudflare, open **Zero Trust**, pick a team name (e.g. `roetech`) and the **Free** plan.
2. **Settings → Authentication → Login methods**: **One-time PIN** (a code by email) is there by
   default. To also sign in with Google, choose **Add new → Google** and follow the steps shown
   (you create an OAuth client in Google Cloud Console with the redirect address Cloudflare
   gives you, `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`).
3. **Access → Applications → Add an application → Self-hosted**:
   - Name: `Site editor`. Domain: `editor.roetechnologyservices.com`.
   - Session duration: how long you stay signed in, e.g. `1 week`.
   - Policy: action **Allow**, rule **Include → Emails**, and enter your Gmail address and your
     Zoho address (only these can get in).
4. Save, then open the editor in a private window: you should see the Cloudflare sign-in page.
   Pick Google, or enter your Zoho address and type the code from the email.

To give someone else access later, add their email to the policy. To remove the login, delete
the application in Zero Trust.

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
security policy in `index.html`/`preview.html` and `CNAME` (removed when `editorDomain` is left
out). Any site that serves a compatible `assets/js/theme-api.js` from the root of its own domain
(over https, from GitHub Pages or any host with CORS enabled) can be edited this way. Sites served
from a sub-folder, such as `user.github.io/repo/`, are not supported.

Drafts, saved versions and GitHub settings are stored per site, so pointing the editor at another
site never publishes one site's draft to the other.

## Development

Requirements: Node.js 22 or newer. No dependencies.

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

## License

Proprietary. All rights reserved. This code is not open source: it may not be copied, reused or
redistributed without written permission. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
