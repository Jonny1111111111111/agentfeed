// Build-time on-chain indexer for AgentFeed.
//
// 0xWork / Bankr agent tokens are launched as Uniswap v4 pools on Base through a
// single shared hook contract, routed via the ERC-4337 EntryPoint. The off-chain
// `/agent/token/launches` API only lists a curated subset (≈346) of that firehose
// (~125 launches/day, mostly spam with no real pool). So we discover launches
// on-chain instead: scan PoolManager `Initialize` events, keep only those created
// by our hook, then filter to the high-signal set — tokens that actually have a
// live DEXScreener pool. 0xWork API identity (verified name/handle/image) is
// overlaid where the token address matches.
//
// Output: src/data/launches.json
import fs from "fs";
import path from "path";

const RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const HOOK = "0xbb7784a4d481184283ed89619a3e3ed143e1adc0".toLowerCase();
const WETH = "0x4200000000000000000000000000000000000006";
// Uniswap v4 PoolManager Initialize(bytes32 indexed id, address indexed c0,
// address indexed c1, uint24 fee, int24 tickSpacing, address hooks, uint160, int24)
const INIT_TOPIC0 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

const CHUNK = 2000; // getLogs block span — capped to stay within public RPC limits
const LOOKBACK_BLOCKS = Number(process.env.LOOKBACK_BLOCKS || 1296000); // ~30 days @2s
const DEX_BATCH = 30; // DEXScreener tokens endpoint cap
const OUT = path.resolve("src/data/launches.json");

let rpcId = 0;
async function rpc(method, params, tries = 8) {
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
      // exponential backoff capped at 8s — survives transient public-RPC drops
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToInt = (h) => parseInt(h, 16);

// Decode an ABI-encoded string (or bytes32) returned from name()/symbol().
function decodeStringResult(hex) {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length === 64) {
    // bytes32 — trim trailing zeros
    const buf = Buffer.from(body, "hex");
    const s = buf.toString("utf8").replace(/\0+$/, "");
    return s || null;
  }
  try {
    const len = parseInt(body.slice(64, 128), 16);
    return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8") || null;
  } catch {
    return null;
  }
}

async function callString(token, selector) {
  try {
    const r = await rpc("eth_call", [{ to: token, data: selector }, "latest"]);
    return decodeStringResult(r);
  } catch {
    return null;
  }
}
const tokenName = (t) => callString(t, "0x06fdde03"); // name()
const tokenSymbol = (t) => callString(t, "0x95d89b41"); // symbol()

// 1) Scan recent PoolManager Initialize events for pools created by our hook.
async function scanHookLaunches(fromBlock, toBlock) {
  const found = new Map(); // token(lower) -> { poolId, block }
  let skipped = 0;
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    // A single chunk failing must not abort the whole scan: rpc() already
    // retries with backoff; if it still throws, skip this chunk and continue.
    let logs;
    try {
      logs = await rpc("eth_getLogs", [
        { address: POOL_MANAGER, topics: [INIT_TOPIC0], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
      ]);
    } catch {
      skipped++;
      continue;
    }
    for (const lg of logs || []) {
      const words = lg.data.slice(2).match(/.{64}/g);
      if (!words || "0x" + words[2].slice(24).toLowerCase() !== HOOK) continue;
      const c0 = "0x" + lg.topics[2].slice(26);
      const c1 = "0x" + lg.topics[3].slice(26);
      const token = c0.toLowerCase() === WETH.toLowerCase() ? c1 : c0;
      found.set(token.toLowerCase(), { poolId: lg.topics[1], block: hexToInt(lg.blockNumber) });
    }
    process.stderr.write(`\r[index] scanned ${to - fromBlock}/${toBlock - fromBlock} blocks · ${found.size} hook tokens · ${skipped} chunks skipped`);
    await sleep(60); // light pacing to ease pressure on the public RPC
  }
  process.stderr.write(`\n[index] scan done: ${found.size} hook tokens, ${skipped} chunks skipped\n`);
  return found;
}

// 2) 0xWork API (paginated) → identity overlay by token address.
// Best-effort: the API is only an overlay, so a failure here must not abort the
// run — we return whatever we managed to fetch.
async function fetchApi() {
  const byAddr = new Map();
  let total = Infinity;
  try {
    for (let off = 0; off < total; off += 50) {
      const res = await fetch(`https://api.0xwork.org/agent/token/launches?limit=50&offset=${off}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) break;
      const j = await res.json();
      total = j.total ?? (j.items || []).length;
      for (const i of j.items || []) if (i.tokenAddress) byAddr.set(i.tokenAddress.toLowerCase(), i);
    }
  } catch (err) {
    console.error(`\n[index] API overlay fetch failed (${err.message}); continuing with ${byAddr.size} entries`);
  }
  return byAddr;
}

// 3) DEXScreener batched market lookup → only tokens with a live pool survive.
// DEXScreener rate-limits the tokens endpoint, so each batch is retried with
// exponential backoff; a batch is only dropped after exhausting retries.
async function fetchMarkets(addresses) {
  const byToken = {};
  let batches = 0,
    failed = 0;
  for (let i = 0; i < addresses.length; i += DEX_BATCH) {
    const batch = addresses.slice(i, i + DEX_BATCH);
    batches++;
    let json = null;
    for (let attempt = 0; attempt < 6 && !json; attempt++) {
      try {
        const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + batch.join(","));
        if (res.status === 429 || res.status >= 500) {
          await sleep(1000 * (attempt + 1)); // backoff on rate-limit / server error
          continue;
        }
        if (!res.ok) break; // 4xx other than 429 — skip this batch
        json = await res.json();
      } catch {
        await sleep(800 * (attempt + 1));
      }
    }
    if (!json) {
      failed++;
    } else {
      for (const p of json.pairs || []) {
        const a = p.baseToken?.address?.toLowerCase();
        if (!a) continue;
        (byToken[a] ??= []).push(p);
      }
    }
    if (batches % 20 === 0) process.stderr.write(`\r[index] dexscreener ${batches} batches · ${failed} failed`);
    await sleep(300); // pacing between batches
  }
  process.stderr.write(`\n[index] dexscreener done: ${batches} batches, ${failed} failed\n`);
  const out = {};
  for (const a in byToken) {
    const ps = byToken[a].sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    const primary = ps[0];
    out[a] = {
      name: primary.baseToken?.name || null,
      symbol: primary.baseToken?.symbol || null,
      poolId: primary.pairAddress || null,
      url: primary.url || null,
      createdAtMs: primary.pairCreatedAt || null,
    };
  }
  return out;
}

const isoFromMs = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const latest = hexToInt(await rpc("eth_blockNumber", []));
  const fromBlock = Math.max(0, latest - LOOKBACK_BLOCKS);
  console.error(`[index] latest=${latest} scanning from ${fromBlock} (hook ${HOOK})`);

  const onchain = await scanHookLaunches(fromBlock, latest);
  const api = await fetchApi();
  console.error(`[index] on-chain hook tokens: ${onchain.size} · API tokens: ${api.size}`);

  // Candidate universe = recent on-chain hook launches ∪ all API tokens.
  const candidates = new Set([...onchain.keys(), ...api.keys()]);
  const markets = await fetchMarkets([...candidates]);
  const kept = Object.keys(markets);
  console.error(`[index] candidates: ${candidates.size} · with live DEX pool: ${kept.length}`);

  const items = [];
  for (const addr of kept) {
    const m = markets[addr];
    const a = api.get(addr);
    const oc = onchain.get(addr);

    // Identity: prefer 0xWork API, then DEXScreener, then on-chain eth_call.
    let name = a?.tokenName || m.name;
    let symbol = a?.tokenSymbol || m.symbol;
    if (!name) name = await tokenName(addr);
    if (!symbol) symbol = await tokenSymbol(addr);

    // Launch date: API createdAt, else the pool-creation block timestamp, else DEX pairCreatedAt.
    let createdAt = a?.createdAt || null;
    if (!createdAt && oc) {
      try {
        const blk = await rpc("eth_getBlockByNumber", ["0x" + oc.block.toString(16), false]);
        createdAt = isoFromMs(hexToInt(blk.timestamp) * 1000);
      } catch {
        /* fall through */
      }
    }
    if (!createdAt && m.createdAtMs) createdAt = isoFromMs(m.createdAtMs);

    items.push({
      tokenName: name || "Unknown",
      tokenSymbol: symbol || "?",
      tokenAddress: a?.tokenAddress || addr,
      imageUrl: a?.imageUrl ?? null,
      createdAt: createdAt || isoFromMs(Date.now()),
      poolId: a?.poolId || oc?.poolId || m.poolId || null,
      launcher: {
        name: a?.launcher?.name ?? null,
        handle: a?.launcher?.handle ?? null,
        image: a?.launcher?.image ?? null,
        verified: !!a?.launcher?.verified,
        operatorAddress: a?.launcher?.operatorAddress ?? null,
        profileUrl: a?.launcher?.profileUrl ?? null,
      },
      feeRecipient: a?.feeRecipient?.value ?? null,
      dexscreenerUrl: a?.public?.dexscreenerUrl ?? m.url ?? `https://dexscreener.com/base/${addr}`,
      launchUrl: a?.public?.launchUrl ?? null,
      basescanUrl: a?.public?.basescanUrl ?? `https://basescan.org/token/${a?.tokenAddress || addr}`,
      source: a ? "token-forge" : "onchain-hook",
    });
  }

  items.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  const payload = {
    generatedAt: new Date().toISOString(),
    hook: HOOK,
    poolManager: POOL_MANAGER,
    lookbackBlocks: LOOKBACK_BLOCKS,
    fromBlock,
    latestBlock: latest,
    count: items.length,
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.error(`[index] wrote ${items.length} pooled tokens -> ${OUT}`);
}

main().catch((err) => {
  console.error(`[index] FAILED: ${err.message}`);
  if (!fs.existsSync(OUT)) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: 0, items: [] }, null, 2));
  }
  process.exit(0); // non-fatal: keep any existing snapshot so the build still succeeds
});
