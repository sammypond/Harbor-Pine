// Harbor & Pine data service (Cloudflare Worker)
//
// The Google API key lives ONLY here, as an encrypted Worker secret named SHEETS_API_KEY.
// It never reaches the browser. The page calls this Worker, the Worker calls Google.
//
// It is read-only and locked down:
//  - only GET requests, only from ALLOWED_ORIGINS
//  - the browser picks a view, never a cell range
//  - results cached for 30 seconds so refreshes don't hit Google every time
//
// Views:
//   (default)      the Owner View tab
//   ?view=orders   orders over the approval threshold that Marcus hasn't approved yet

const OWNER_TAB = "Owner View";
// Order must match KEYS in index.html
const OWNER_RANGES = ["B2", "B4", "B5", "B6", "A9:D14", "B16", "A21:B26"];
const ROW_START = 5;   // first invoice row on each restaurant tab
const ROW_END = 500;   // read well past the data so new rows are included

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
    const respond = (text, status = 200) =>
      new Response(text, { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    const json = (obj, status = 200) => respond(JSON.stringify(obj), status);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Read-only: only GET is allowed" }, 405);
    if (!originOk) return json({ error: "This data service only answers the Harbor & Pine site" }, 403);
    if (!env.SHEETS_API_KEY || !env.SPREADSHEET_ID) return json({ error: "Data service isn't configured yet" }, 500);

    const view = new URL(request.url).searchParams.get("view") || "owner";
    let build;
    if (view === "owner") build = () => ownerView(env);
    else if (view === "orders") build = () => ordersView(env);
    else return json({ error: "Unknown view" }, 404);

    // Serve from cache when fresh
    const cache = caches.default;
    const cacheKey = new Request("https://cache.local/" + view, { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return respond(await hit.text());

    try {
      const out = JSON.stringify(await build());
      ctx.waitUntil(cache.put(cacheKey, new Response(out, { headers: { "Cache-Control": "max-age=30" } })));
      return respond(out);
    } catch (e) {
      return json({ error: e.publicMessage || "Couldn't read the sheet" }, e.status || 502);
    }
  },
};

// ---------- Google Sheets helpers (the key stays server-side) ----------

function fail(message, status) { const e = new Error(message); e.publicMessage = message; e.status = status; return e; }

async function google(env, path, params) {
  const p = new URLSearchParams(params);
  p.set("key", env.SHEETS_API_KEY);
  let res, body;
  try {
    res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(env.SPREADSHEET_ID) + path + "?" + p, { method: "GET" });
    body = await res.json();
  } catch (e) {
    throw fail("Couldn't reach Google Sheets", 502);
  }
  // Pass Google's reason through, but never the request URL (it contains the key)
  if (!res.ok) throw fail((body && body.error && body.error.message) || "Google Sheets returned an error", res.status);
  return body;
}

async function batchGet(env, ranges) {
  const p = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE" });
  ranges.forEach((r) => p.append("ranges", r));
  const body = await google(env, "/values:batchGet", p);
  return (body.valueRanges || []).map((v) => v.values || []);
}

const tabRef = (name) => "'" + String(name).replace(/'/g, "''") + "'";
const money = (s) => { const n = parseFloat(String(s == null ? "" : s).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };

// ---------- Views ----------

async function ownerView(env) {
  const values = await batchGet(env, OWNER_RANGES.map((r) => tabRef(OWNER_TAB) + "!" + r));
  return { valueRanges: values.map((v) => ({ values: v })) };
}

async function ordersView(env) {
  // Restaurant names and GMs come from the Lists tab, so only real restaurant tabs are read
  const [locs] = await batchGet(env, ["Lists!A2:B30"]);
  const locations = locs.filter((r) => r[0]).map((r) => ({ name: String(r[0]), gm: String(r[1] || "") }));

  // Tab IDs, for "Open in Google Sheets" links that land on the right row
  const props = await google(env, "", { fields: "sheets.properties(sheetId,title)" });
  const gids = {};
  (props.sheets || []).forEach((s) => { gids[s.properties.title] = s.properties.sheetId; });

  const tabs = await batchGet(env, locations.map((l) => tabRef(l.name) + "!A" + ROW_START + ":H" + ROW_END));
  const base = "https://docs.google.com/spreadsheets/d/" + env.SPREADSHEET_ID + "/edit";
  const orders = [];
  locations.forEach((loc, li) => {
    (tabs[li] || []).forEach((r, i) => {
      // Same rule as the sheet: needs Marcus's OK and isn't approved (or declined) yet
      if (!r || r[6] !== "Yes" || r[7] === "Approved" || r[7] === "Declined") return;
      const row = ROW_START + i;
      orders.push({
        location: loc.name, gm: loc.gm,
        date: r[1] || "", vendor: r[2] || "", category: r[3] || "", invoice: r[4] || "",
        amount: money(r[5]), status: r[7] || "Pending",
        link: gids[loc.name] != null ? base + "#gid=" + gids[loc.name] + "&range=A" + row + ":H" + row : base,
      });
    });
  });
  orders.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)); // oldest first
  return { count: orders.length, total: orders.reduce((s, o) => s + o.amount, 0), orders };
}
