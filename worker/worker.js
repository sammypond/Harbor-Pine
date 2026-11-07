// Harbor & Pine data service (Cloudflare Worker)
//
// The Google API key lives ONLY here, as an encrypted Worker secret named SHEETS_API_KEY.
// It never reaches the browser. The page calls this Worker, the Worker calls Google.
//
// It is read-only and locked down:
//  - only GET requests
//  - only the Owner View cells (the browser can't ask for anything else)
//  - only answers pages served from ALLOWED_ORIGINS
//  - results cached for 30 seconds so refreshes don't hit Google every time

const TAB = "Owner View";
// Order must match KEYS in index.html
const RANGES = ["B2", "B4", "B5", "B6", "A9:D14", "B16", "A21:B26"];

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const originOk = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk ? origin : (allowed[0] || ""),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Read-only: only GET is allowed" }, 405);
    if (!originOk) return json({ error: "This data service only answers the Harbor & Pine site" }, 403);
    if (!env.SHEETS_API_KEY || !env.SPREADSHEET_ID) return json({ error: "Data service isn't configured yet" }, 500);

    // Serve from cache when fresh
    const cache = caches.default;
    const cacheKey = new Request("https://cache.local/owner-view", { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    const params = new URLSearchParams({ key: env.SHEETS_API_KEY, valueRenderOption: "FORMATTED_VALUE" });
    const tab = "'" + TAB.replace(/'/g, "''") + "'";
    RANGES.forEach((r) => params.append("ranges", tab + "!" + r));
    const url = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(env.SPREADSHEET_ID) + "/values:batchGet?" + params;

    let res, body;
    try {
      res = await fetch(url, { method: "GET" });
      body = await res.json();
    } catch (e) {
      return json({ error: "Couldn't reach Google Sheets" }, 502);
    }
    if (!res.ok) {
      // Pass Google's reason through, but never the request URL (it contains the key)
      return json({ error: (body && body.error && body.error.message) || "Google Sheets returned an error" }, res.status);
    }

    // Return only the cell values, nothing else from Google's response
    const out = JSON.stringify({ valueRanges: (body.valueRanges || []).map((v) => ({ values: v.values || [] })) });
    ctx.waitUntil(cache.put(cacheKey, new Response(out, { headers: { "Cache-Control": "max-age=30" } })));
    return new Response(out, { status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  },
};
