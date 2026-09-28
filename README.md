# Truman Electronics — Website

Replacement corporate website for **Truman Electronics**, one of Egypt's leading
companies in household appliances, electronics and security systems, founded in
**1987**.

Built as a single, self-contained front end (`index.html`) with a tiny
zero-dependency Node server that also handles the contact form. No build step.

## What's included

| File | Purpose |
|------|---------|
| `index.html` | The full website — **bilingual English / Arabic (RTL)**, all styles & scripts inline |
| `server.js` | Zero-dependency Node static server **+ `/api/contact` handler** |
| `404.html` | Custom not-found page |
| `favicon.svg` | Brand mark |
| `robots.txt`, `sitemap.xml` | Basic SEO |
| `package.json`, `railway.json` | Railway / Nixpacks config |
| `.nojekyll`, `.gitignore`, `LICENSE` | Repo housekeeping |

## Content is grounded in the real brand

The site mirrors Truman's actual structure rather than placeholder content:

- **Four product families:** Atmosphere (Air Conditioning, Fans) · Entertainment
  (LED TVs, 4K/Curved, Receivers, TV Wall Mounts, Accessories) · Assistant
  (Electric Ovens, Gas Cookers, Kettles) · Monitoring (Cameras, XVRs).
- **Real contact details:** 174 Tahrir St., Babellouk, Cairo · Factory: 76 Abu
  Rawash Industrial City · (+202) 2395 6003 / 6004 · info@trumanelectronics.com ·
  facebook.com/trumanelectronics.
- **Bilingual:** an EN/AR toggle switches every string and flips the layout to
  RTL, matching the original site's two languages.

## Run locally

```bash
node server.js          # then open http://localhost:3000
```

## Deploy to Railway

`server.js` binds to Railway's injected `$PORT`; `package.json` + `railway.json`
make the build deterministic (Nixpacks, no dependencies to install).

**Dashboard:** push to GitHub → railway.app → **New Project → Deploy from GitHub
repo** → pick the repo → Railway runs `node server.js` → **Settings → Networking
→ Generate Domain** for a public URL (add your custom domain there).

**CLI:**
```bash
npm i -g @railway/cli
railway login && railway init && railway up && railway domain
```

## Contact form — make submissions arrive somewhere

The `/api/contact` endpoint validates input and works out of the box (it logs
submissions if nothing is configured). To actually receive messages, set **one**
of these on your host (Railway → service → **Variables**):

**Option A — Webhook (simplest; Slack / Discord / Zapier / Make / n8n):**
```
CONTACT_WEBHOOK_URL = https://hooks.your-service.com/...
```

**Option B — Email via Resend (https://resend.com):**
```
RESEND_API_KEY = re_xxxxxxxx
CONTACT_TO     = info@trumanelectronics.com
CONTACT_FROM   = website@your-verified-domain.com
```

No variables required to deploy — the form still returns success and logs the
message until you wire delivery.

## Replacing the current trumanelectronics.com

1. Point the domain (or a staging subdomain) at this deployment.
2. Set a contact-form variable (above) so enquiries reach the team.
3. Update `sitemap.xml` / `robots.txt` if the final domain differs.
4. Optional next steps: add real product photography, individual product pages,
   and the Arabic-language `og:` image. This build is a complete, functional
   home page; per-product catalogue pages can be layered on top.

> Note: this version intentionally drops two things that were on an earlier draft
> but are **not** part of the real brand — a "German technology" claim and a
> speculative B2B satellite-solutions section — so it stays an accurate stand-in
> for the live site. Both can be re-added if desired.

---
© 2026 Truman Electronics. All rights reserved.

## Logo

The official **TRUMAN® — your life partner** logo is used in the header and footer.
It's embedded directly in `index.html` as a transparent PNG data URI, so it renders
everywhere (deployed, served locally, or opening the file directly) with no external
request. The source assets are in `assets/`:
- `assets/logo.png` — white, transparent background (for dark surfaces)
- `assets/logo-dark.png` — dark version (for light surfaces)

To update the logo later, drop a new file into `assets/` and either re-embed it as a
data URI or point the header/footer `<img>` at `assets/logo.png`.

## Hero background

The hero uses an original, license-clean SVG illustration of a living room with the
Truman product families in view (LED TV, split AC, standing fan, water dispenser,
CCTV camera, satellite receiver and a kettle). To use a real photograph instead,
set it as the `.hero-bg` background-image and keep the dark overlay for legibility.

## Product data & catalogue

Product families, featured products, the full model range, the company story
(incl. the Dubai/UAE branch and hotline **19903**) and all contact details are
taken from Truman's official product catalogue. The catalogue PDF ships in
`assets/Truman-Catalogue.pdf` and is linked from the contact section
("Download full catalogue"). Replace that file to update the downloadable catalogue.
