# Grocery Tracker

A personal weekly grocery dashboard. Receipts go in via Claude OCR each week; data lives in a Google Sheet; the dashboard is a static site you can host on GitHub Pages, Cloudflare Pages, or Netlify.

## Architecture

```
  receipt photo  ─►  Claude (OCR + normalize)  ─►  Apps Script /exec  ─►  Google Sheet
                                                          ▲
                                                          │ Pull (GET)
                                                          │ Flag (POST)
                                                          │
                                                  GitHub Pages dashboard
```

- **Google Sheet** — source of truth. Tabs: `Receipts`, `LineItems`, `ItemAliases`, `Categories`, `FlaggedRows`, `Meta`.
- **Apps Script (`Code.gs`)** — bound to the Sheet, exposes `doGet` (read all) and `doPost` (mutate ops: appendReceipt, flagRow, upsertAlias, etc.) at an HTTPS endpoint.
- **Dashboard (`index.html` + `styles.css` + `app.js`)** — static, vanilla JS, Chart.js. Calls the Apps Script endpoint over HTTPS.

## Files

| File | Purpose |
|---|---|
| `Code.gs` | Apps Script backend — paste into the Sheet's bound script |
| `index.html` | Thin dashboard shell |
| `styles.css` | Personal Design System styling |
| `app.js` | Dashboard logic (state, sync, views, charts) |
| `SETUP.md` | One-time setup instructions |
| `README.md` | This file |

## Setup

See [SETUP.md](./SETUP.md) for the full one-time setup. Roughly:

1. Create a Google Sheet, paste `Code.gs` into its bound Apps Script project, run `setup()`.
2. Deploy the script as a web app — copy the `/exec` URL.
3. Push this repo to GitHub, enable Pages.
4. Open the dashboard, paste the URL into Sync settings.

## Adding receipts

Drop a photo of any receipt into a Claude chat each week — Claude will OCR it, normalize item names, and post it to the Sheet via the `appendReceipt` op. Then click **Pull** in the dashboard.

## Dashboard views

- **Dashboard** — KPI strip, weekly trend (Sun–Sat), category donut, store breakdown, cross-store volatility table, frequently-bought items
- **Stores** — per-store deep dive: top categories, top items, average prices
- **Categories** — per-category breakdown with top items
- **Items** — searchable table of every distinct item (normalized) with min/max/avg prices and stores
- **Receipts** — most-recent-first list with line-item detail and a flag button per line

The **per-unit / per-package** toggle changes how prices are compared:

- **Per unit** uses each line's `unit_price` (price per oz/lb/ea/etc.) — best for comparing Costco's bulk packs against TJ's small packs on the same item.
- **Per package** uses `line_total / qty` — what you actually paid per package as bought.

## Stack notes

- No build step, no framework.
- Chart.js loaded from CDN.
- Cormorant Garamond + DM Sans fonts via fontsource CDN.
- Sync URL stored in `localStorage` per browser — does not get committed to the repo.

## Repo

This is a personal project — single user, scoped to my own grocery shopping. Not designed for multi-user collaboration. The Apps Script URL is the only secret; everything else (categories, item aliases, receipts) lives in your Sheet.
