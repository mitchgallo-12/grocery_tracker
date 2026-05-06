# Grocery Tracker — One-time setup

This is a personal weekly grocery dashboard that uses a Google Sheet as its database and a static GitHub Pages site as its UI. Receipts get OCR'd in your Claude chat each week and posted into the Sheet via an Apps Script web-app endpoint. The dashboard pulls from that same endpoint.

There is no automatic background sync. The dashboard has a **Pull** button you click whenever you want to refresh.

## What you'll set up (about 15 minutes, once)

1. A new Google Sheet, owned by you.
2. An Apps Script project bound to that Sheet, containing `Code.gs`.
3. A web-app deployment of that script — gives you an HTTPS URL the dashboard calls.
4. The dashboard hosted on GitHub Pages, with the URL pasted into Sync settings (one click per device).

## Step 1 — Create the Sheet

1. In Google Drive, create a new blank Google Sheet.
2. Name it something obvious like **Grocery Tracker — Live**.
3. (Optional) Move it into a folder you find later, e.g. *Personal/Tracking*.

Leave it on the default empty Sheet1 — the script will create the real tabs.

## Step 2 — Open the Apps Script editor

In the Sheet, go to **Extensions → Apps Script**. A new tab opens with an editor and a default `Code.gs` file containing a stub `myFunction()`.

You're going to replace the contents of that default file.

### 2a. Paste Code.gs

1. Select all of the default `Code.gs` content and delete it.
2. Open `Code.gs` from this repo, copy the entire contents, and paste them into the editor.
3. Save with **Cmd/Ctrl-S**.

### 2b. Rename the project (optional)

Click the title at the top (default: "Untitled project") and rename to **Grocery Tracker Backend**. Easier to find later.

## Step 3 — Initialize the Sheet

In the Apps Script editor, with `Code.gs` selected:

1. **Function dropdown** (just left of the Run button) → choose `setup`.
2. Click **Run**.
3. The first time, you'll be asked to authorize the script. Walk through:
   - "Review permissions" → pick your account.
   - You may see "Google hasn't verified this app" — that's normal for a private script. Click **Advanced → Go to Grocery Tracker Backend (unsafe) → Allow**. The script only touches this one Sheet; nothing else in your Drive.
4. Switch back to the Sheet tab. You should see all the tabs created: `Meta`, `Receipts`, `LineItems`, `ItemAliases`, `Categories`, `FlaggedRows`. The `Categories` tab is pre-seeded with default categories.

## Step 4 — Deploy as a Web App

This is what gives the dashboard an HTTPS URL to call.

1. In the Apps Script editor, top right: **Deploy → New deployment**.
2. Click the gear icon next to "Select type" → **Web app**.
3. Configure:
   - **Description:** Grocery Tracker v1
   - **Execute as:** Me (your account) ← important
   - **Who has access:** Anyone with Google account
4. Click **Deploy**.
5. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfycbx.../exec`.

**Why "Execute as: Me"** — the script runs under your identity and writes to your Sheet. Anyone hitting the URL just calls the API; they don't need their own Sheet permissions.

**Security note** — that URL is a bearer token. Anyone who has it can read and write the Sheet. Don't paste it into Slack, email, or anywhere it could get indexed. Hand it to yourself via a password manager.

## Step 5 — Host the dashboard

### Option A — GitHub Pages

1. Push this repo (`grocery-tracker`) to GitHub.
2. In the repo settings → **Pages** → **Source: Deploy from a branch** → branch `main`, folder `/ (root)`. Save.
3. Wait ~30 seconds. Your dashboard URL is `https://<your-username>.github.io/grocery-tracker/`.

> **Private repo?** GitHub Pages on private repos requires GitHub Pro. If you don't have Pro, either keep the repo public (the Apps Script URL is the actual secret — the dashboard code is harmless without it) or use Cloudflare Pages / Netlify, which both support private repos on free tiers.

### Option B — Cloudflare Pages (private repo, free)

1. Push the repo to GitHub (private is fine).
2. Go to Cloudflare → Pages → Create a project → Connect to Git → pick the repo.
3. Build settings: framework preset **None**, build command empty, output directory `/`.
4. Deploy. You'll get a `*.pages.dev` URL.

## Step 6 — Connect the dashboard

1. Open your dashboard URL in any browser.
2. In the sidebar, click **Sync** (or the **Pull** button on first run).
3. Paste the Apps Script Web app URL. Click **Save**.
4. The dashboard does its first Pull automatically.

The browser remembers the URL in `localStorage`, so you only do this once per device.

## Adding receipts

Each week, drop a receipt photo into your Claude chat and say something like *"add this receipt to my grocery tracker."* I'll:

1. OCR the receipt — extract date, store, items, qty/unit, prices, total.
2. Match items against your `ItemAliases` tab so cross-store comparison stays consistent.
3. Call the Apps Script `appendReceipt` op to write the receipt and line items to your Sheet.
4. Tell you what I added so you can verify.

Then in the dashboard, click **Pull** to refresh.

## Editing directly in the Sheet

The Sheet is the source of truth. You can edit it directly any time:

- **Headers are sacred.** Don't rename, reorder, or delete the column headers — the script reads by position.
- **IDs must stay unique** within their tab.
- **Foreign keys matter.** A row in `LineItems` with `receipt_id = rcpt_xyz` only makes sense if `rcpt_xyz` exists in `Receipts`.
- **Categories** can be added freely — type new names directly in the `Categories` tab.
- **ItemAliases** is your normalization table — edit the `normalized_name` or `category` for any raw item name to retrain how that item rolls up everywhere.

## Updating Code.gs later

If `Code.gs` changes in the repo, copy the new contents back into the Apps Script editor:

1. Open the Apps Script editor for the same project.
2. Replace the contents of `Code.gs`.
3. **Deploy → Manage deployments → pencil icon → Version: New version → Deploy.**
4. The URL stays the same — no need to re-paste it in your browser.

## Troubleshooting

**"Pull failed: HTTP 403"** — the deployment isn't accessible. Check **Deploy → Manage deployments → Web app → Who has access** is set to "Anyone with Google account."

**"Got HTML/non-JSON"** — the URL is returning a Google login page. Almost always means the deployment is set to "Only myself" or you used the editor URL instead of the `/exec` web-app URL.

**"Pull failed: HTTP 401"** — same as 403. Re-check the deployment's access setting.

**Push works but no data appears in the Sheet** — open the Apps Script editor → **Executions** in the left rail, click the latest `doPost` to see the error trace.

**Want to start fresh** — run `clearAllData()` in Apps Script to wipe data rows (keeps headers and re-seeds default categories).
