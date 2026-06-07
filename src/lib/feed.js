// Runtime data layer for the AgentFeed dashboard.
//
// Two live sources, both browser-reachable (CORS: *):
//  1. Base public RPC (mainnet.base.org) — we poll PoolManager `Initialize`
//     events created by the shared agent-launch hook to detect NEW token
//     launches on-chain. The build-time indexer (scripts/index-launches.mjs)
//     snapshots the high-signal set (launches with a live DEX pool) to
//     src/data/launches.json.
//  2. DEXScreener for live price / volume / liquidity / FDV / change.
//     The tokens endpoint accepts at most 30 addresses per request, so we batch.
//
// Fees are estimated as: 24h volume × agent share (0.57) × swap fee rate (1.2%).

import verified from "../data/verified.json";
import clanker from "../data/clanker.json";

// ── 0xWork verified set ──
// Source of truth for the "0xWork" tag: the verified launch list pulled from
// 0xwork.org/launches (scripts/pull-0xwork-verified.mjs, refreshed by the
// scheduled GitHub Action). A token is "0xWork" iff its address is in this set.
// Membership is checked at runtime, so re-indexing launches.json never drops the
// tag and a launch 0xWork un-verifies simply falls out of the set on next pull.
export const VERIFIED_0XWORK = new Set((verified.addresses || []).map((a) => a.toLowerCase()));
export const is0xWork = (address) => !!address && VERIFIED_0XWORK.has(address.toLowerCase());

// ── Clanker set ──
// Source of truth for the "Clanker" tag: live-pool tokens pulled from the Clanker
// API + v4 factory (scripts/pull-clanker.mjs). Same membership-at-runtime model.
export const CLANKER = new Set((clanker.addresses || []).map((a) => a.toLowerCase()));
export const isClanker = (address) => !!address && CLANKER.has(address.toLowerCase());

// ── Base on-chain config (Uniswap v4 launch hook) ──
const BASE_RPC = "https://mainnet.base.org";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
export const LAUNCH_HOOK = "0xbb7784a4d481184283ed89619a3e3ed143e1adc0".toLowerCase();
const WETH = "0x4200000000000000000000000000000000000006";
const INIT_TOPIC0 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const RUNTIME_LOOKBACK_BLOCKS = 2000; // max blocks polled per cycle

const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";
const DEX_BATCH = 30; // DEXScreener caps the tokens endpoint at 30 addresses

export const SWAP_FEE_RATE = 0.012; // 1.2% swap fee on token-forge pools
export const FEE_AGENT_SHARE = 0.57; // creator/agent share of the fee

export const computeFees = (volume24h) => volume24h * FEE_AGENT_SHARE * SWAP_FEE_RATE;

export function mapLaunch(i) {
  return {
    launchId: i.launchId,
    tokenName: i.tokenName,
    tokenSymbol: i.tokenSymbol,
    tokenAddress: i.tokenAddress,
    imageUrl: i.imageUrl ?? null,
    createdAt: i.createdAt,
    source: i.source ?? null, // "onchain-hook" (Bankr/Doppler shared launch hook), "clanker", etc.
    is0xWork: is0xWork(i.tokenAddress), // 0xWork tag = membership in the verified set
    isClanker: isClanker(i.tokenAddress), // Clanker tag = membership in the Clanker set
    launcher: {
      name: i.launcher?.name ?? null,
      handle: i.launcher?.handle ?? null,
      image: i.launcher?.image ?? null,
      // The old per-token launcher.verified flag was unreliable; the verified
      // set (verified.json) is now authoritative.
      verified: is0xWork(i.tokenAddress),
      operatorAddress: i.launcher?.operatorAddress ?? null,
      profileUrl: i.launcher?.profileUrl ?? null,
    },
    feeRecipient: i.feeRecipient ?? i.feeRecipient?.value ?? null,
    dexscreenerUrl: i.dexscreenerUrl ?? i.public?.dexscreenerUrl ?? null,
    launchUrl: i.launchUrl ?? i.public?.launchUrl ?? null,
    basescanUrl: i.basescanUrl ?? i.public?.basescanUrl ?? null,
  };
}

// Stable key grouping tokens that share a launcher: verified operator address
// first, else the fee-recipient wallet, else the token itself (ungrouped).
export function agentKey(token) {
  return (
    token.launcher?.operatorAddress?.toLowerCase() ||
    token.feeRecipient?.toLowerCase() ||
    token.tokenAddress.toLowerCase()
  );
}

// ── Base RPC helpers ──
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function getLatestBlock() {
  return parseInt(await rpc("eth_blockNumber", []), 16);
}

/**
 * Poll PoolManager Initialize events between two blocks and return the launches
 * created by our launch hook. Each result is a partial token record (address +
 * poolId + block); callers enrich with DEXScreener/identity. The block span
 * should stay within RUNTIME_LOOKBACK_BLOCKS to respect public-RPC limits.
 */
export async function fetchNewLaunches(fromBlock, toBlock) {
  const logs = await rpc("eth_getLogs", [
    {
      address: POOL_MANAGER,
      topics: [INIT_TOPIC0],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    },
  ]);
  const out = [];
  for (const lg of logs || []) {
    const words = lg.data.slice(2).match(/.{64}/g);
    if (!words || "0x" + words[2].slice(24).toLowerCase() !== LAUNCH_HOOK) continue;
    const c0 = "0x" + lg.topics[2].slice(26);
    const c1 = "0x" + lg.topics[3].slice(26);
    const token = c0.toLowerCase() === WETH.toLowerCase() ? c1 : c0;
    out.push({
      tokenAddress: token,
      poolId: lg.topics[1],
      block: parseInt(lg.blockNumber, 16),
      dexscreenerUrl: `https://dexscreener.com/base/${token}`,
      basescanUrl: `https://basescan.org/token/${token}`,
    });
  }
  return out;
}

// Resolve a token's name()/symbol() via eth_call (ABI string or bytes32).
const hexToUtf8 = (hex) => {
  const bytes = hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, "");
};
function decodeStringResult(hex) {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length === 64) return hexToUtf8(body) || null;
  try {
    const len = parseInt(body.slice(64, 128), 16);
    return hexToUtf8(body.slice(128, 128 + len * 2)) || null;
  } catch {
    return null;
  }
}

// eth_call for an ABI string, retried a few times — the public RPC is flaky on
// freshly-created tokens, which is what made new-launch toasts show "?".
async function ethCallString(to, data, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const s = decodeStringResult(await rpc("eth_call", [{ to, data }, "latest"]));
      if (s) return s;
    } catch {
      /* transient — retry */
    }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  return null;
}

export async function resolveTokenMeta(tokenAddress) {
  let [name, symbol] = await Promise.all([
    ethCallString(tokenAddress, "0x06fdde03"), // name()
    ethCallString(tokenAddress, "0x95d89b41"), // symbol()
  ]);
  // Fallback to DEXScreener metadata if the chain calls didn't resolve.
  if (!name || !symbol) {
    try {
      const res = await fetch(DEX_TOKENS + tokenAddress);
      if (res.ok) {
        const bt = ((await res.json()).pairs || [])[0]?.baseToken;
        if (bt) {
          name = name || bt.name || null;
          symbol = symbol || bt.symbol || null;
        }
      }
    } catch {
      /* ignore — keep whatever we have */
    }
  }
  return { name, symbol };
}

/**
 * Batch-fetch DEXScreener market data for many token addresses, 30 per request.
 * For each token: primary pair = highest-liquidity pool; volume & liquidity are
 * summed across that token's pools. Returns an object keyed by lowercase address.
 * Individual batch failures are tolerated so one bad chunk doesn't blank the board.
 */
// A no-pool stub recorded for an address that a SUCCESSFUL DEXScreener response
// returned no pair for — i.e. "fetched and confirmed no/zero volume". Distinct
// from a token we simply haven't fetched yet (whose `market` stays undefined),
// so the UI can keep unfetched tokens visible and only hide confirmed-zero ones.
const NO_POOL_MARKET = { hasPool: false, volume24h: 0, liquidityUsd: 0, txns24h: 0, priceUsd: 0, priceChange24h: 0 };

// Fetch + aggregate a single ≤30-address batch into per-token market objects
// (keyed by lowercase address). A token's pools all come back in its own batch
// (we query by token address), so per-batch aggregation is complete and safe to
// emit progressively. On a SUCCESSFUL response every requested address gets an
// entry (real data or a no-pool stub) so callers can tell "confirmed zero" from
// "not fetched". Returns {} only on a failed batch (network/HTTP), so those
// tokens stay unfetched and visible rather than being wrongly marked zero.
async function fetchMarketBatch(batch) {
  let json;
  try {
    const res = await fetch(DEX_TOKENS + batch.join(","));
    if (!res.ok) return {};
    json = await res.json();
  } catch {
    return {};
  }
  const byToken = {};
  for (const p of json.pairs || []) {
    const a = p.baseToken?.address?.toLowerCase();
    if (!a) continue;
    (byToken[a] ??= []).push(p);
  }
  const out = {};
  for (const a in byToken) {
    const ps = byToken[a].sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    const primary = ps[0];
    const volume24h = ps.reduce((s, p) => s + (p.volume?.h24 || 0), 0);
    const liquidityUsd = ps.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
    const txns24h = ps.reduce((s, p) => s + ((p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0)), 0);
    out[a] = {
      hasPool: true,
      priceUsd: Number(primary.priceUsd) || 0,
      priceNative: Number(primary.priceNative) || 0, // token price in the quote token (WETH/ETH)
      quoteSymbol: primary.quoteToken?.symbol || "ETH",
      volume24h,
      liquidityUsd,
      txns24h,
      fdv: primary.fdv || 0,
      priceChange24h: primary.priceChange?.h24 ?? 0,
      url: primary.url,
      dexId: primary.dexId,
      imageUrl: primary.info?.imageUrl || null, // token image from DEXScreener
    };
  }
  // Response succeeded → mark every requested address we got no pair for as a
  // confirmed no-pool token (so it can be filtered out, but only now, not before).
  for (const addr of batch) {
    const lc = addr.toLowerCase();
    if (!out[lc]) out[lc] = NO_POOL_MARKET;
  }
  return out;
}

export async function fetchMarkets(addresses) {
  const out = {};
  if (!addresses.length) return out;
  for (let i = 0; i < addresses.length; i += DEX_BATCH) {
    Object.assign(out, await fetchMarketBatch(addresses.slice(i, i + DEX_BATCH)));
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Progressive variant for first paint: fetch ≤30 addresses at a time and hand
 * each batch's result to `onBatch` as soon as it lands, with a short gap between
 * batches so 478 tokens don't fire as one burst (which stalled / rate-limited
 * the initial load). The caller can merge each partial in so the board fills in
 * incrementally instead of waiting for the whole sweep.
 */
export async function fetchMarketsProgressive(addresses, onBatch, { delayMs = 120 } = {}) {
  if (!addresses.length) return;
  for (let i = 0; i < addresses.length; i += DEX_BATCH) {
    const partial = await fetchMarketBatch(addresses.slice(i, i + DEX_BATCH));
    if (Object.keys(partial).length) onBatch?.(partial);
    if (delayMs && i + DEX_BATCH < addresses.length) await sleep(delayMs);
  }
}

// ── DEXScreener market cache (sessionStorage, 5-min TTL) ──
// Lets a revisit within the TTL paint live market data instantly and skip the
// DEXScreener sweep entirely. Keyed map: { lcAddress: market }.
const MARKETS_CACHE_KEY = "feedr:markets:v1";
const MARKETS_TTL_MS = 5 * 60 * 1000;

export function loadCachedMarkets() {
  try {
    const raw = sessionStorage.getItem(MARKETS_CACHE_KEY);
    if (!raw) return null;
    const { ts, markets } = JSON.parse(raw);
    if (!ts || Date.now() - ts > MARKETS_TTL_MS || !markets) return null;
    return markets;
  } catch {
    return null;
  }
}

export function saveCachedMarkets(markets) {
  try {
    sessionStorage.setItem(MARKETS_CACHE_KEY, JSON.stringify({ ts: Date.now(), markets }));
  } catch {
    /* storage unavailable or over quota — caching is best-effort */
  }
}

// ── formatting + presentation helpers ──
export function fmtUsd(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n > 0) return "$" + n.toPrecision(3);
  return "$0";
}

export function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return Math.round(n).toString();
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

// Prefer the platform-provided DEXScreener link, else build one from the address.
export const dexUrl = (token) =>
  token.market?.url || token.dexscreenerUrl || `https://dexscreener.com/base/${token.tokenAddress}`;

export const basescanUrl = (token) =>
  token.basescanUrl || `https://basescan.org/token/${token.tokenAddress}`;

// Display name for the launching agent: launcher.name, else @handle, else null.
export function agentLabel(token) {
  const l = token.launcher || {};
  if (l.name) return l.name;
  if (l.handle) return l.handle.startsWith("@") ? l.handle : `@${l.handle}`;
  return null;
}

const AVATARS = ["🦈", "🤖", "🐙", "🔐", "🌊", "💧", "🧠", "⚡", "🦾", "🛰️", "🔮", "🎯", "🧩", "🚀", "🦉", "🐬"];
export function avatarFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export function daysSince(createdAt) {
  const t = Date.parse(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

export const nowTime = () =>
  new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
