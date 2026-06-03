// Pull the 0xWork *verified* launch list — the source of truth for Feedr's
// "0xWork" tag — and keep it in sync automatically.
//
// Why this is a dedicated pull (not just the launches API):
// 0xWork's public token-forge API (api.0xwork.org/agent/token/launches) is
// CORS-locked to https://www.0xwork.org, so the browser can't read it at
// runtime. On top of that, its public read path is currently serving a FROZEN
// snapshot to external clients (it reports verifiedLaunches:8 / launches24h:0,
// no matter the query or cache-busting), while 0xwork.org/launches itself —
// rendered server-side — shows the live stat (verifiedLaunches:26). So no
// single public endpoint exposes all the verified token addresses today.
//
// To get as close as possible AND auto-heal when their cache un-freezes, we
// UNION two public sources and dedupe by token address:
//   1. GET /agent/token/launches?verified=true  (paginated)  — the older set.
//   2. The server-rendered 0xwork.org/launches HTML (Next.js RSC payload) —
//      the newest launches, including verified ones absent from source #1.
// The moment 0xWork's public API recovers, source #1 returns the full set and
// the next scheduled run picks them all up with no code change.
//
// Output:
//   - src/data/verified.json : { addresses[], agents[], sources, count, ... }
//   - merges any verified token missing from launches.json into it so verified
//     agents still appear in the feed (the runtime tag itself is computed from
//     verified.json membership in src/lib/feed.js, so re-indexing never drops it).
import fs from "fs";
import path from "path";

const API = "https://api.0xwork.org/agent/token/launches";
const PAGE_URL = "https://www.0xwork.org/launches";
const ORIGIN = "https://www.0xwork.org"; // API reflects ACAO only for this origin
const OUT = path.resolve("src/data/verified.json");
const LAUNCHES = path.resolve("src/data/launches.json");

const lc = (a) => (a ? String(a).toLowerCase() : a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json", origin: ORIGIN } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(500 * 2 ** i);
    }
  }
}

// Normalize one launch into the shape verified.json stores.
function normalize(i) {
  if (!i?.tokenAddress) return null;
  return {
    tokenAddress: i.tokenAddress,
    tokenName: i.tokenName || null,
    tokenSymbol: i.tokenSymbol || null,
    imageUrl: i.imageUrl ?? i.launcher?.image ?? null,
    poolId: i.poolId ?? null,
    createdAt: i.createdAt ?? null,
    name: i.launcher?.name ?? null,
    handle: i.launcher?.handle ?? null,
    operatorAddress: i.launcher?.operatorAddress ?? null,
    profileUrl: i.launcher?.profileUrl ?? null,
    dexscreenerUrl: i.public?.dexscreenerUrl ?? `https://dexscreener.com/base/${i.tokenAddress}`,
    basescanUrl: i.public?.basescanUrl ?? `https://basescan.org/token/${i.tokenAddress}`,
  };
}

// Source 1 — the public verified-launches API (paginated). Best-effort.
async function fromApi() {
  const out = [];
  try {
    let total = Infinity;
    for (let off = 0; off < total; off += 50) {
      const j = await getJson(`${API}?verified=true&limit=50&offset=${off}`);
      total = j.total ?? (j.items || []).length;
      for (const i of j.items || []) if (i.launcher?.verified) out.push(normalize(i));
      if (!(j.items || []).length) break;
    }
    console.error(`[verified] API source: ${out.length} verified launches`);
  } catch (err) {
    console.error(`[verified] API source failed (${err.message}); continuing`);
  }
  return out.filter(Boolean);
}

// Source 2 — scrape the server-rendered launches page. The Next.js RSC payload
// is embedded as self.__next_f.push([1,"<escaped string>"]) chunks; concatenate
// the decoded strings, then pull verified launch objects out of the blob.
async function fromPage() {
  const out = [];
  let stats = null;
  try {
    const res = await fetch(PAGE_URL, { headers: { "user-agent": "Mozilla/5.0 (FeedrBot)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    let blob = "";
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    for (let m; (m = re.exec(html)); ) {
      try {
        blob += JSON.parse(m[1]); // m[1] is a JSON-encoded string literal
      } catch {
        /* skip a malformed chunk */
      }
    }

    const sm = blob.match(/"stats":\{[^}]*\}/);
    if (sm) {
      try {
        stats = JSON.parse(sm[0].slice('"stats":'.length));
      } catch {
        /* ignore */
      }
    }

    // Split the blob on launch boundaries and keep the verified ones.
    const parts = blob.split('"launchId":');
    for (let k = 1; k < parts.length; k++) {
      const seg = parts[k];
      const addr = seg.match(/"tokenAddress":"(0x[0-9a-fA-F]{40})"/);
      const ver = seg.match(/"verified":(true|false)/);
      if (!addr || !ver || ver[1] !== "true") continue;
      const grab = (key) => {
        const mm = seg.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
        return mm ? mm[1] : null;
      };
      out.push(
        normalize({
          tokenAddress: addr[1],
          tokenName: grab("tokenName"),
          tokenSymbol: grab("tokenSymbol"),
          imageUrl: grab("imageUrl"),
          poolId: grab("poolId"),
          createdAt: grab("createdAt"),
          launcher: { name: grab("name"), handle: grab("handle"), verified: true },
        })
      );
    }
    console.error(`[verified] page source: ${out.length} verified launches (page stat: ${stats?.verifiedLaunches ?? "?"})`);
  } catch (err) {
    console.error(`[verified] page source failed (${err.message}); continuing`);
  }
  return { items: out.filter(Boolean), stats };
}

function keepExisting(reason) {
  if (fs.existsSync(OUT)) {
    console.error(`[verified] ${reason}; keeping existing ${path.basename(OUT)}`);
    process.exit(0);
  }
  console.error(`[verified] ${reason}; no existing snapshot — writing empty`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: 0, addresses: [], agents: [] }, null, 2));
  process.exit(0);
}

async function main() {
  const [apiItems, page] = await Promise.all([fromApi(), fromPage()]);

  // Union by lowercased address; prefer the entry that carries the most identity.
  const byAddr = new Map();
  const score = (x) => (x.name ? 2 : 0) + (x.handle ? 2 : 0) + (x.tokenName ? 1 : 0) + (x.imageUrl ? 1 : 0);
  for (const it of [...apiItems, ...page.items]) {
    const key = lc(it.tokenAddress);
    const prev = byAddr.get(key);
    if (!prev || score(it) > score(prev)) byAddr.set(key, { ...prev, ...it });
  }

  const agents = [...byAddr.values()].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const addresses = agents.map((a) => lc(a.tokenAddress));

  // Guard: never overwrite a good snapshot with an empty pull (transient outage).
  if (!addresses.length) keepExisting("both sources returned 0 verified launches");

  const expected = page.stats?.verifiedLaunches ?? null;
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "0xwork.org/launches (verified)",
    sources: { api: apiItems.length, page: page.items.length },
    expectedVerified: expected, // 0xWork's own server-side stat, for transparency
    count: addresses.length,
    addresses,
    agents,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.error(
    `[verified] wrote ${addresses.length} unique verified tokens -> ${path.basename(OUT)}` +
      (expected != null ? ` (0xWork reports ${expected} verified; ${expected - addresses.length} not yet public)` : "")
  );

  // Merge any verified token missing from launches.json so verified agents still
  // appear in the feed. The runtime tag is computed from verified.json membership
  // (see src/lib/feed.js), so this merge only ensures the tokens EXIST.
  mergeIntoLaunches(agents);
}

function mergeIntoLaunches(agents) {
  if (!fs.existsSync(LAUNCHES)) {
    console.error(`[verified] ${path.basename(LAUNCHES)} not found; skipping merge`);
    return;
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(LAUNCHES, "utf8"));
  } catch (err) {
    console.error(`[verified] could not read launches.json (${err.message}); skipping merge`);
    return;
  }
  const items = snap.items || [];
  const have = new Set(items.map((i) => lc(i.tokenAddress)));
  let added = 0;
  for (const a of agents) {
    if (have.has(lc(a.tokenAddress))) continue;
    items.push({
      tokenName: a.tokenName || "Unknown",
      tokenSymbol: a.tokenSymbol || "?",
      tokenAddress: a.tokenAddress,
      imageUrl: a.imageUrl ?? null,
      createdAt: a.createdAt || new Date().toISOString().replace("T", " ").slice(0, 19),
      poolId: a.poolId || null,
      launcher: {
        name: a.name ?? null,
        handle: a.handle ?? null,
        image: a.imageUrl ?? null,
        verified: true,
        operatorAddress: a.operatorAddress ?? null,
        profileUrl: a.profileUrl ?? null,
      },
      feeRecipient: null,
      dexscreenerUrl: a.dexscreenerUrl,
      launchUrl: a.profileUrl ?? null,
      basescanUrl: a.basescanUrl,
      source: "token-forge",
    });
    added++;
    have.add(lc(a.tokenAddress));
  }
  if (added) {
    items.sort((x, y) => Date.parse((y.createdAt || "").replace(" ", "T")) - Date.parse((x.createdAt || "").replace(" ", "T")));
    snap.items = items;
    snap.count = items.length;
    fs.writeFileSync(LAUNCHES, JSON.stringify(snap, null, 2));
    console.error(`[verified] merged ${added} verified token(s) into launches.json (now ${items.length})`);
  } else {
    console.error(`[verified] all verified tokens already present in launches.json`);
  }
}

main().catch((err) => keepExisting(`pull failed (${err.message})`));
