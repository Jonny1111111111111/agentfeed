// Runtime data layer for the AgentFeed dashboard.
//
// Two live sources, both reachable from the browser:
//  1. 0xWork verified token launches — api.0xwork.org is CORS-blocked, so we
//     route it through the allorigins public CORS proxy. A build-time snapshot
//     (src/data/launches.json) is the always-available fallback.
//  2. DEXScreener (CORS: *) for live price / volume / liquidity / FDV / change.
//
// Fees are estimated as: 24h volume × agent share (0.57) × swap fee rate.

const LAUNCHES_URL = "https://api.0xwork.org/agent/token/launches?verified=true&limit=100";
const PROXY = (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`;
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";

export const SWAP_FEE_RATE = 0.003; // 0.3% AMM swap fee (token-forge pools are Uniswap v4)
export const FEE_AGENT_SHARE = 0.57;

export const computeFees = (volume24h) => volume24h * FEE_AGENT_SHARE * SWAP_FEE_RATE;

export function mapLaunch(i) {
  return {
    launchId: i.launchId,
    tokenName: i.tokenName,
    tokenSymbol: i.tokenSymbol,
    agentName: i.launcher?.name ?? i.agentName ?? null,
    tokenAddress: i.tokenAddress,
    createdAt: i.createdAt,
  };
}

/** Live verified launches via CORS proxy. Throws on failure so callers can fall back. */
export async function fetchLaunchesLive() {
  const res = await fetch(PROXY(LAUNCHES_URL), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`launches proxy HTTP ${res.status}`);
  const json = JSON.parse(await res.text());
  return (json.items || []).filter((i) => i.launcher?.verified && i.tokenAddress).map(mapLaunch);
}

/**
 * Batch-fetch DEXScreener market data for many token addresses (one request).
 * For each token: primary pair = highest-liquidity pool; volume & liquidity are
 * summed across that token's pools. Returns Map(lowerAddr -> market | undefined).
 */
export async function fetchMarkets(addresses) {
  const out = {};
  if (!addresses.length) return out;
  const res = await fetch(DEX_TOKENS + addresses.join(","));
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const json = await res.json();
  const byToken = {};
  for (const p of json.pairs || []) {
    const a = p.baseToken?.address?.toLowerCase();
    if (!a) continue;
    (byToken[a] ??= []).push(p);
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
export const dexUrl = (token) => token.market?.url || `https://dexscreener.com/base/${token.tokenAddress}`;

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
