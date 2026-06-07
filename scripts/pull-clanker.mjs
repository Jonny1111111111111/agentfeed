// Pull Clanker token launches and keep the high-signal (live-pool) set in sync.
//
// Source strategy (confirmed): API primary + on-chain fallback.
//   1. Clanker REST API — https://www.clanker.world/api/tokens (newest-first,
//      page size capped at 20, multi-chain so we filter chain_id === 8453).
//      It's CORS-locked to clanker.world, so we pull it here server-side, not at
//      runtime. It carries identity but no live price/volume.
//   2. On-chain fallback — the Clanker v4 factory's TokenCreated events over a
//      small recent block window, for immediacy / if the API lags.
//
// Selection (confirmed): recent window + persisted set. Each run we union the
// newest API tokens + recent on-chain events + the tokens we already track
// (src/data/clanker.json), then DEXScreener-filter the whole union to keep only
// those with a live pool. The tracked set therefore accumulates real Clanker
// tokens over time and self-prunes when a pool dies. 706k total Clanker tokens
// makes a full historical scan impractical; this stays fast and RPC-light.
//
// Output:
//   - src/data/clanker.json : { addresses[], items[], ... } (source of truth tag)
//   - merges each token into src/data/launches.json with source:"clanker" so it
//     shows in the feed. The runtime tag is membership in clanker.json (see
//     src/lib/feed.js), so a re-index can never drop it.
import fs from "fs";
import path from "path";

const CLANKER_API = "https://www.clanker.world/api/tokens";
const RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const V4_FACTORY = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9";
const TOKEN_CREATED_TOPIC0 = "0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67";
const CHAIN_ID = 8453;

const API_LIMIT = 20; // hard cap — the API rejects limit >= 25
const NEWEST_PAGES = Number(process.env.CLANKER_PAGES || 40); // ~800 newest tokens
const ONCHAIN_LOOKBACK = Number(process.env.CLANKER_LOOKBACK_BLOCKS || 9000); // ~5h; one getLogs call within the public-RPC 10k cap
const DEX_BATCH = 30;

// Hard high-signal thresholds: only keep tokens DEXScreener shows with real,
// active trading. Applied in the data pipeline (not the UI) so launches.json is
// already the trimmed source of truth and the runtime has far fewer tokens to
// price. Override via env for tuning.
const MIN_VOL_24H = Number(process.env.CLANKER_MIN_VOL || 500);
const MIN_TXNS_24H = Number(process.env.CLANKER_MIN_TXNS || 100);

const OUT = path.resolve("src/data/clanker.json");
const LAUNCHES = path.resolve("src/data/launches.json");

const lc = (a) => (a ? String(a).toLowerCase() : a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoFromMs = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// ── 1. Clanker API (newest pages, Base only) ──
async function fromApi() {
  const map = new Map(); // addr -> identity
  try {
    let emptyStreak = 0;
    // NOTE: the API's `page` param is broken (always returns the newest 20);
    // pagination is offset-based, so we step `offset` by the page size.
    for (let page = 0; page < NEWEST_PAGES; page++) {
      const offset = page * API_LIMIT;
      let j;
      for (let attempt = 0; attempt < 4 && !j; attempt++) {
        try {
          const res = await fetch(`${CLANKER_API}?offset=${offset}&limit=${API_LIMIT}`, { headers: { accept: "application/json" } });
          if (res.status === 429 || res.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
          if (!res.ok) break;
          j = await res.json();
        } catch { await sleep(600 * (attempt + 1)); }
      }
      const rows = j?.data || [];
      // A single empty/failed page is usually a transient rate-limit, not the end
      // of the list — only stop after several consecutive empties.
      if (!rows.length) {
        if (++emptyStreak >= 3) break;
        await sleep(500);
        continue;
      }
      emptyStreak = 0;
      for (const t of rows) {
        if (t.chain_id !== CHAIN_ID || !t.contract_address) continue;
        map.set(lc(t.contract_address), {
          tokenAddress: t.contract_address,
          tokenName: t.name || null,
          tokenSymbol: t.symbol || null,
          imageUrl: t.img_url || null,
          createdAt: t.deployed_at ? isoFromMs(Date.parse(t.deployed_at)) : null,
          admin: t.admin || t.msg_sender || null,
          type: t.type || null,
        });
      }
      await sleep(120); // gentle pacing
    }
    console.error(`[clanker] API: ${map.size} Base tokens from ${NEWEST_PAGES} newest pages`);
  } catch (err) {
    console.error(`[clanker] API source failed (${err.message}); continuing`);
  }
  return map;
}

// ── 2. On-chain fallback: recent v4 factory TokenCreated events ──
let rpcId = 0;
async function rpc(method, params, tries = 5) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (err) {
      if (attempt === tries - 1) throw err;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
}

async function fromChain() {
  const addrs = new Set();
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    const from = Math.max(0, latest - ONCHAIN_LOOKBACK);
    const logs = await rpc("eth_getLogs", [
      { address: V4_FACTORY, topics: [TOKEN_CREATED_TOPIC0], fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16) },
    ]);
    for (const l of logs || []) addrs.add(lc("0x" + l.topics[1].slice(26))); // token = first indexed param
    console.error(`[clanker] on-chain: ${addrs.size} tokens from last ${ONCHAIN_LOOKBACK} blocks`);
  } catch (err) {
    console.error(`[clanker] on-chain source failed (${err.message}); continuing (best-effort)`);
  }
  return addrs;
}

// ── 3. DEXScreener high-signal filter (live pool) ──
async function fetchMarkets(addresses) {
  const byToken = {};
  for (let i = 0; i < addresses.length; i += DEX_BATCH) {
    const batch = addresses.slice(i, i + DEX_BATCH);
    let json = null;
    for (let attempt = 0; attempt < 6 && !json; attempt++) {
      try {
        const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + batch.join(","));
        if (res.status === 429 || res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
        if (!res.ok) break;
        json = await res.json();
      } catch { await sleep(800 * (attempt + 1)); }
    }
    for (const p of json?.pairs || []) {
      const a = lc(p.baseToken?.address);
      if (!a) continue;
      (byToken[a] ??= []).push(p);
    }
    await sleep(250);
  }
  const out = {};
  let dropped = 0;
  for (const a in byToken) {
    const ps = byToken[a].sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    const primary = ps[0];
    // Sum across all of the token's pools (24h volume + buy/sell txn count).
    const volume24h = ps.reduce((s, p) => s + (p.volume?.h24 || 0), 0);
    const txns24h = ps.reduce((s, p) => s + ((p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)), 0);
    // Hard filter: only real, active markets survive into the data files.
    if (!(volume24h > MIN_VOL_24H && txns24h > MIN_TXNS_24H)) { dropped++; continue; }
    out[a] = {
      name: primary.baseToken?.name || null,
      symbol: primary.baseToken?.symbol || null,
      poolId: primary.pairAddress || null,
      url: primary.url || null,
      imageUrl: primary.info?.imageUrl || null,
      createdAtMs: primary.pairCreatedAt || null,
      volume24h,
      txns24h,
    };
  }
  console.error(`[clanker] DEXScreener: ${Object.keys(out).length} kept (vol>${MIN_VOL_24H} & txns>${MIN_TXNS_24H}), ${dropped} below threshold`);
  return out;
}

function keepExisting(reason) {
  if (fs.existsSync(OUT)) {
    console.error(`[clanker] ${reason}; keeping existing ${path.basename(OUT)}`);
    process.exit(0);
  }
  console.error(`[clanker] ${reason}; no existing snapshot — writing empty`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: 0, addresses: [], items: [] }, null, 2));
  process.exit(0);
}

async function main() {
  // Persisted set — tokens we already track survive into the next run.
  let prev = { addresses: [], items: [] };
  if (fs.existsSync(OUT)) {
    try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { /* fresh */ }
  }
  const prevById = new Map((prev.items || []).map((it) => [lc(it.tokenAddress), it]));

  const [apiMap, chainSet] = await Promise.all([fromApi(), fromChain()]);

  // Candidate universe = newest API ∪ recent on-chain ∪ previously tracked.
  const candidates = new Set([...apiMap.keys(), ...chainSet, ...(prev.addresses || []).map(lc)]);
  if (!candidates.size) keepExisting("no candidates from any source");
  console.error(`[clanker] candidates: ${candidates.size} (api ${apiMap.size}, chain ${chainSet.size}, persisted ${(prev.addresses || []).length})`);

  const markets = await fetchMarkets([...candidates]);
  const kept = Object.keys(markets); // only tokens with a live DEX pool survive
  if (!kept.length) keepExisting("DEXScreener returned no live pools (transient?)");

  const items = kept.map((addr) => {
    const a = apiMap.get(addr) || prevById.get(addr) || {};
    const m = markets[addr];
    const admin = a.admin || null;
    return {
      tokenName: a.tokenName || m.name || "Unknown",
      tokenSymbol: a.tokenSymbol || m.symbol || "?",
      tokenAddress: a.tokenAddress || addr,
      imageUrl: a.imageUrl || m.imageUrl || null,
      createdAt: a.createdAt || (m.createdAtMs ? isoFromMs(m.createdAtMs) : isoFromMs(Date.now())),
      poolId: m.poolId || null,
      // Group tokens by their Clanker admin so they roll up into one agent.
      launcher: { name: null, handle: null, image: a.imageUrl || null, verified: false, operatorAddress: admin, profileUrl: null },
      feeRecipient: admin,
      dexscreenerUrl: m.url || `https://dexscreener.com/base/${addr}`,
      basescanUrl: `https://basescan.org/token/${a.tokenAddress || addr}`,
      source: "clanker",
      // Snapshot of the stats this token passed the filter on (informational).
      volume24h: m.volume24h,
      txns24h: m.txns24h,
    };
  });
  items.sort((x, y) => Date.parse((y.createdAt || "").replace(" ", "T")) - Date.parse((x.createdAt || "").replace(" ", "T")));

  const addresses = items.map((i) => lc(i.tokenAddress));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "clanker.world API + v4 factory " + V4_FACTORY,
    factory: V4_FACTORY,
    sources: { api: apiMap.size, chain: chainSet.size, persisted: (prev.addresses || []).length },
    count: addresses.length,
    addresses,
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  const grew = addresses.length - (prev.addresses || []).length;
  console.error(`[clanker] wrote ${addresses.length} live-pool tokens -> ${path.basename(OUT)} (${grew >= 0 ? "+" : ""}${grew} vs last run)`);

  mergeIntoLaunches(items);
}

function mergeIntoLaunches(items) {
  if (!fs.existsSync(LAUNCHES)) { console.error(`[clanker] ${path.basename(LAUNCHES)} not found; skipping merge`); return; }
  let snap;
  try { snap = JSON.parse(fs.readFileSync(LAUNCHES, "utf8")); } catch (err) {
    console.error(`[clanker] could not read launches.json (${err.message}); skipping merge`); return;
  }
  const keep = new Set(items.map((it) => lc(it.tokenAddress)));
  // Prune stale clanker tokens: a clanker-sourced entry that's no longer in the
  // freshly filtered set (dead pool or below the volume/txns threshold) must drop
  // out of launches.json too — otherwise the merge would only ever accumulate.
  // Non-clanker sources (onchain-hook, token-forge) are left untouched.
  const before = (snap.items || []).length;
  let list = (snap.items || []).filter((i) => i.source !== "clanker" || keep.has(lc(i.tokenAddress)));
  const pruned = before - list.length;

  const byAddr = new Map(list.map((i) => [lc(i.tokenAddress), i]));
  let added = 0, tagged = 0;
  for (const it of items) {
    const ex = byAddr.get(lc(it.tokenAddress));
    if (ex) {
      if (ex.source !== "clanker") { ex.source = "clanker"; tagged++; }
      ex.launcher = ex.launcher?.name || ex.launcher?.handle ? ex.launcher : it.launcher;
    } else { list.push(it); added++; }
  }
  list.sort((x, y) => Date.parse((y.createdAt || "").replace(" ", "T")) - Date.parse((x.createdAt || "").replace(" ", "T")));
  snap.items = list;
  snap.count = list.length;
  fs.writeFileSync(LAUNCHES, JSON.stringify(snap, null, 2));
  console.error(`[clanker] launches.json: +${added} new, ${tagged} re-tagged, -${pruned} pruned clanker (now ${list.length})`);
}

main().catch((err) => keepExisting(`pull failed (${err.message})`));
