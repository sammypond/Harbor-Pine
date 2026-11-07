// Harbor & Pine data service (Cloudflare Worker)
//
// The Google API key lives ONLY here, as an encrypted Worker secret named SHEETS_API_KEY.
// It never reaches the browser. The page calls this Worker, the Worker calls Google.
//
// Read-only and locked down:
//  - only GET requests, only from ALLOWED_ORIGINS
//  - the browser picks a view, never a cell range; restaurant names are checked
//    against the Lists tab before anything is read
//  - results cached for 30 seconds
//
// Views:
//   (default)             Owner View tab, same shape as before
//   ?view=orders          every order over the approval threshold not yet approved
//   ?view=location&name=X one restaurant's numbers for the latest week

const OWNER_TAB = "Owner View";
// Order must match KEYS in index.html
const OWNER_RANGES = ["B2", "B4", "B5", "B6", "A9:D14", "B16", "A21:B26"];
const ROW_START = 5;      // first invoice row on each restaurant tab
const ROW_END = 500;      // read well past the data so new rows are included
const CACHE_SECONDS = 30;

let metaCache = null;     // Lists tab + tab IDs, reused for 5 minutes per Worker instance

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

    const url = new URL(request.url);
    const view = url.searchParams.get("view") || "owner";
    const name = (url.searchParams.get("name") || "").slice(0, 60);

    let key, build;
    if (view === "owner") { key = "owner"; build = () => ownerView(env); }
    else if (view === "orders") { key = "orders"; build = () => ordersView(env); }
    else if (view === "location") { key = "location:" + name; build = () => locationView(env, name); }
    else return json({ error: "Unknown view" }, 404);

    // Serve from cache when fresh
    const cache = caches.default;
    const cacheKey = new Request("https://cache.local/" + encodeURIComponent(key), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return respond(await hit.text());

    try {
      const out = JSON.stringify(await build());
      ctx.waitUntil(cache.put(cacheKey, new Response(out, { headers: { "Cache-Control": "max-age=" + CACHE_SECONDS } })));
      return respond(out);
    } catch (e) {
      return json({ error: e.publicMessage || "Couldn't read the sheet" }, e.status || 502);
    }
  },
};

// ---------- Google Sheets helpers (key stays server-side) ----------

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
const pct = (s) => { const n = parseFloat(String(s == null ? "" : s).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
const isWaiting = (r) => r[6] === "Yes" && r[7] !== "Approved" && r[7] !== "Declined";

// Locations, GMs, categories (Lists tab) and each tab's ID for "Open in Google Sheets" links
async function meta(env) {
  if (metaCache && Date.now() - metaCache.at < 5 * 60 * 1000) return metaCache.data;
  const [locs, cats] = await batchGet(env, ["Lists!A2:B30", "Lists!D2:D30"]);
  const props = await google(env, "", { fields: "sheets.properties(sheetId,title)" });
  const gids = {};
  (props.sheets || []).forEach((s) => { gids[s.properties.title] = s.properties.sheetId; });
  const data = {
    locations: locs.filter((r) => r[0]).map((r) => ({ name: String(r[0]), gm: String(r[1] || "") })),
    categories: cats.filter((r) => r[0]).map((r) => String(r[0])),
    gids,
  };
  metaCache = { at: Date.now(), data };
  return data;
}

function sheetLink(env, gid, row) {
  const base = "https://docs.google.com/spreadsheets/d/" + env.SPREADSHEET_ID + "/edit";
  if (gid == null) return base;
  return base + "#gid=" + gid + (row ? "&range=A" + row + ":H" + row : "");
}

// ---------- Views ----------

async function ownerView(env) {
  const values = await batchGet(env, OWNER_RANGES.map((r) => tabRef(OWNER_TAB) + "!" + r));
  return { valueRanges: values.map((v) => ({ values: v })) };
}

async function ordersView(env) {
  const m = await meta(env);
  const tabs = await batchGet(env, m.locations.map((l) => tabRef(l.name) + "!A" + ROW_START + ":H" + ROW_END));
  const orders = [];
  m.locations.forEach((loc, li) => {
    (tabs[li] || []).forEach((r, i) => {
      if (!r || !isWaiting(r)) return;
      const row = ROW_START + i;
      orders.push({
        location: loc.name, gm: loc.gm,
        week: r[0] || "", date: r[1] || "", vendor: r[2] || "", category: r[3] || "",
        invoice: r[4] || "", amount: money(r[5]), status: r[7] || "Pending",
        link: sheetLink(env, m.gids[loc.name], row),
      });
    });
  });
  orders.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)); // oldest first
  return { count: orders.length, total: orders.reduce((s, o) => s + o.amount, 0), orders };
}

async function locationView(env, name) {
  const m = await meta(env);
  const loc = m.locations.find((l) => l.name === name);
  if (!loc) throw fail("Unknown location", 404); // only names from the Lists tab can be read

  const [weekCell, targetCell, rows, sales] = await batchGet(env, [
    tabRef(OWNER_TAB) + "!B2",
    tabRef(OWNER_TAB) + "!B5",
    tabRef(loc.name) + "!A" + ROW_START + ":H" + ROW_END,
    tabRef(loc.name) + "!J5:K60",
  ]);
  const week = (weekCell[0] && weekCell[0][0]) || "";
  const target = pct(targetCell[0] && targetCell[0][0]);

  const invoices = rows.filter((r) => r && r[0] === week && r[5] != null && r[5] !== "");
  const salesRow = sales.find((r) => r && r[0] === week);
  const foodSales = salesRow ? money(salesRow[1]) : 0;

  const byCat = {};
  m.categories.forEach((c) => { byCat[c] = 0; });
  invoices.forEach((r) => { const c = r[3] || "Other"; byCat[c] = (byCat[c] || 0) + money(r[5]); });
  const purchases = Object.values(byCat).reduce((s, v) => s + v, 0);
  const foodCost = foodSales > 0 ? Math.round((purchases / foodSales) * 1000) / 10 : null;

  let status = "Not in yet";
  if (invoices.length && foodSales > 0) status = target != null && foodCost > target ? "Over target" : "On target";
  else if (invoices.length) status = "No sales yet";

  const dates = rows.map((r) => r && Date.parse(r[1])).filter(Boolean);
  const last = dates.length ? new Date(Math.max(...dates)) : null;

  const top = invoices
    .map((r) => ({ date: r[1] || "", vendor: r[2] || "", category: r[3] || "", invoice: r[4] || "", amount: money(r[5]), waiting: isWaiting(r), approved: r[7] === "Approved" }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    name: loc.name, gm: loc.gm, week, target,
    foodSales, purchases, foodCost, status,
    waiting: rows.filter((r) => r && isWaiting(r)).length,
    invoiceCount: invoices.length,
    lastInvoice: last ? (last.getMonth() + 1) + "/" + last.getDate() + "/" + last.getFullYear() : "",
    byCategory: Object.keys(byCat).map((c) => ({ category: c, amount: byCat[c] })),
    topInvoices: top,
    link: sheetLink(env, m.gids[loc.name]),
  };
}
