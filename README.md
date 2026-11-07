# Harbor & Pine Owner View

A read-only, phone-friendly view of the **Owner View** tab in the Harbor_Pine_Food_Cost Google Sheet.

## How the API key stays private

A static site (GitHub Pages) can't keep a secret. Anything in `index.html` or any other file it loads can be read by anyone. So the key is not in this site at all:

```
iPhone / browser  -->  Cloudflare Worker (holds the key)  -->  Google Sheets API
   index.html            worker/worker.js
   config.js (only the Worker's address)
```

The Worker only allows GET requests, only returns the Owner View cells, only answers pages from `https://sammypond.github.io`, and never sends the key back.

## Files

| File | Goes to GitHub? | What it is |
|---|---|---|
| `index.html` | Yes | The page |
| `config.js` | Yes | The Worker's address (not secret) |
| `worker/worker.js` | Optional | The Worker code (no secret inside) |
| `worker/wrangler.toml` | Optional | Worker settings (no secret inside) |
| `.gitignore` | Yes | Keeps local secret files out of Git |

## Setup

### 1. Replace the old key (it was published)
The old key is in this repo's commit history on GitHub, so treat it as public.
In Google Cloud Console > APIs & Services > Credentials:
1. Delete the old key.
2. Create a new API key.
3. Under **API restrictions**, choose **Restrict key** and select **Google Sheets API** only.
4. Leave **Application restrictions** as **None** (the Worker calls Google from a server, not a website).

### 2. Create the Worker (Cloudflare dashboard, no command line)
1. Sign in at dash.cloudflare.com (free plan is fine) > **Workers & Pages** > **Create** > **Create Worker**.
2. Name it `harbor-pine-data`, click **Deploy**, then **Edit code**.
3. Replace everything with the contents of `worker/worker.js` and click **Deploy**.
4. Go to the Worker's **Settings > Variables and Secrets** and add:
   - `SHEETS_API_KEY` as type **Secret**: your new API key
   - `SPREADSHEET_ID` as type **Text**: `1cY9eSEAP9D2EJz9nIa2ow-2uf9MMRhDL2U1Gl5lI40g`
   - `ALLOWED_ORIGINS` as type **Text**: `https://sammypond.github.io`
5. Copy the Worker's address, like `https://harbor-pine-data.YOURNAME.workers.dev`.

### 3. Point the page at the Worker
Open `config.js` and set `DATA_URL` to the Worker's address. Then commit and push:

```
git add index.html config.js .gitignore README.md worker
git commit -m "Move API key to a Cloudflare Worker"
git push
```

Site: https://sammypond.github.io/Harbor-Pine/

## Testing
- With `DATA_URL` empty, the page shows demo data and a "Demo data" badge.
- With it set, the badge says "Live" and the time of the last refresh.
- Opening the file directly from your computer will say it can't reach the data service, because the Worker only answers the GitHub Pages address. That's expected.
