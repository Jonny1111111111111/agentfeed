// Runtime data layer for the AgentFeed dashboard.
//
// Two live sources:
//  1. 0xWork token launches — api.0xwork.org is CORS-blocked, so we route it
//     through the allorigins public CORS proxy. A build-time snapshot
//     (src/data/launches.json) holds all ~346 launches as the always-available
//     fallback. At runtime we only need page 1 (newest launchIds) to detect new
//     launches by diffing the max launchId.
//  2. DEXScreener (CORS: *) for live price / volume / liquidity / FDV / change.
//     The tokens endpoint accepts at most 30 addresses per request, so we batch.
//
// Fees are estimated as: 24h volume × agent share (0.57) × swap fee rate (1.2%).

const BASE = "https://api.0xwork.org/agent/token/launches";
const LAUNCHES_PAGE1 = `${BASE}?limit=50&offset=0`;
const PROXY = (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`;
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
    launcher: {
      name: i.launcher?.name ?? null,
      handle: i.launcher?.handle ?? null,
      image: i.launcher?.image ?? null,
      verified: !!i.launcher?.verified,
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

/**
 * Live launches (page 1, newest first) via the CORS proxy. Used only for
 * new-launch detection. Throws on failure so callers can fall back.
 */
export async function fetchLaunchesLive() {
  const res = await fetch(PROXY(LAUNCHES_PAGE1), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`launches proxy HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  return (json.items || []).filter((i) => i.tokenAddress).map(mapLaunch);
}

/**
 * Batch-fetch DEXScreener market data for many token addresses, 30 per request.
 * For each token: primary pair = highest-liquidity pool; volume & liquidity are
 * summed across that token's pools. Returns an object keyed by lowercase address.
 * Individual batch failures are tolerated so one bad chunk doesn't blank the board.
 */
export async function fetchMarkets(addresses) {
  const out = {};
  if (!addresses.length) return out;
  const byToken = {};
  for (let i = 0; i < addresses.length; i += DEX_BATCH) {
    const batch = addresses.slice(i, i + DEX_BATCH);
    let json;
    try {
      const res = await fetch(DEX_TOKENS + batch.join(","));
      if (!res.ok) continue;
      json = await res.json();
    } catch {
      continue;
    }
    for (const p of json.pairs || []) {
      const a = p.baseToken?.address?.toLowerCase();
      if (!a) continue;
      (byToken[a] ??= []).push(p);
    }
  }
  for (const a in byToken) {
    const ps = byToken[a].sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    const primary = ps[0];
    const volume24h = ps.reduce((s, p) => s + (p.volume?.h24 || 0), 0);
    const liquidityUsd = ps.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
    out[a] = {
      hasPool: true,
      priceUsd: Number(primary.priceUsd) || 0,
      volume24h,
      liquidityUsd,
      fdv: primary.fdv || 0,
      priceChange24h: primary.priceChange?.h24 ?? 0,
      url: primary.url,
      dexId: primary.dexId,
    };
  }
  return out;
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
