import { useState, useEffect, useRef, useMemo } from "react";
import snapshot from "./data/launches.json";
import {
  mapLaunch,
  getLatestBlock,
  fetchNewLaunches,
  resolveTokenMeta,
  fetchMarkets,
  fetchMarketsProgressive,
  computeFees,
  fmtUsd,
  fmtNum,
  short,
  dexUrl,
  basescanUrl,
  agentLabel,
  agentKey,
  daysSince,
  is0xWork,
  isClanker,
  RUNTIME_LOOKBACK_BLOCKS,
} from "./lib/feed";

const DEX_POLL_MS = 30000;
const LAUNCH_POLL_MS = 60000;
const NEW_DAYS = 7;

// AGE column label: always a real elapsed time — minutes under 1h ("45m"),
// hours under 1d ("6h"), else days ("3d"). Never "NEW" or "—".
const ageLabel = (createdAt) => {
  const d = daysSince(createdAt); // days as a float (Infinity if unparseable)
  const mins = Number.isFinite(d) ? Math.max(0, d * 1440) : 0;
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
};
const MAX_NEW_PER_CYCLE = 8; // cap additions per poll to survive spam bursts

// Derive the agent roster from the live token feed. An "agent" is the launcher
// behind a group of tokens (keyed by operator/fee-recipient/token via agentKey).
// We only surface agents that have at least one token with an active DEX pool and
// real fees or volume — no static registry. Aggregates feed the Agents tab + detail.
function buildAgents(tokens) {
  const groups = {};
  for (const t of tokens) (groups[agentKey(t)] ??= []).push(t);
  const out = [];
  for (const key in groups) {
    const toks = groups[key]
      .filter((t) => t.market?.hasPool && ((t.fees || 0) > 0 || (t.market?.volume24h || 0) > 0))
      .sort((a, b) => (b.fees || 0) - (a.fees || 0));
    if (!toks.length) continue;
    // Identity comes from whichever token carries launcher metadata (most are anonymous).
    const idTok =
      toks.find((t) => t.launcher?.name || t.launcher?.handle) ||
      toks.find((t) => t.launcher?.operatorAddress || t.feeRecipient) ||
      toks[0];
    const operatorAddress = idTok.launcher?.operatorAddress || null;
    const feeRecipient = idTok.feeRecipient || null;
    out.push({
      key,
      name: idTok.launcher?.name || null,
      handle: idTok.launcher?.handle || null,
      image: idTok.launcher?.image || toks.find((t) => t.imageUrl)?.imageUrl || null,
      verified: toks.some((t) => t.is0xWork),
      operatorAddress,
      feeRecipient,
      wallet: operatorAddress || feeRecipient || null, // secondary identity only
      tokens: toks,
      tokensLaunched: toks.length,
      totalFees: toks.reduce((s, t) => s + (t.fees || 0), 0),
      totalVolume: toks.reduce((s, t) => s + (t.market?.volume24h || 0), 0),
      totalTxns: toks.reduce((s, t) => s + (t.market?.txns24h || 0), 0),
      // Oldest token (max age) drives the AGE column; newest (min age) drives the NEW badge.
      oldestCreatedAt: toks.reduce((o, t) => (daysSince(t.createdAt) > daysSince(o) ? t.createdAt : o), toks[0].createdAt),
      newestCreatedAt: toks.reduce((n, t) => (daysSince(t.createdAt) < daysSince(n) ? t.createdAt : n), toks[0].createdAt),
      best: toks[0], // highest-fee token
    });
  }
  return out.sort((a, b) => b.totalFees - a.totalFees);
}

// Share-card footer branding.
const SHARE_HANDLE = "@feedr_base";

function makeToken(launch) {
  return { ...launch, market: null, fees: 0, isNew: false };
}

const fmtDate = (createdAt) => {
  const t = Date.parse((createdAt || "").replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// Single neutral placeholder shown for every token/agent without an image — one
// simple muted "coin" mark, instead of a unique generated avatar per token.
function DefaultAvatar({ size = 44 }) {
  return (
    <span className="af-av-emoji" style={{ width: size, height: size }}>
      <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="#6b6b72" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="3.4" fill="#6b6b72" />
      </svg>
    </span>
  );
}

// Avatar: real launcher/token image if available, else the default placeholder.
function Avatar({ token, size = 44 }) {
  const img = tokenImage(token);
  if (img)
    return <img className="af-av-img" style={{ width: size, height: size }} src={img} alt="" loading="lazy" />;
  return <DefaultAvatar size={size} />;
}

// Generic avatar for an arbitrary image URL (used for agents); falls back to the
// same default placeholder. `seed` is retained only for call-site compatibility.
function PicAvatar({ src, seed, size = 44 }) {
  void seed;
  if (src) return <img className="af-av-img" style={{ width: size, height: size }} src={src} alt="" loading="lazy" />;
  return <DefaultAvatar size={size} />;
}

// Agent tiers, derived from total estimated 24h fees across an agent's tokens.
const TIER_COLOR = { Bronze: "#CD7F32", Silver: "#C0C0C0", Gold: "#FFD700", Platinum: "#E5E4E2" };
const tierForFees = (fees = 0) =>
  fees >= 1000 ? "Platinum" : fees >= 200 ? "Gold" : fees >= 25 ? "Silver" : "Bronze";

// Platform a token/agent belongs to.
//  • 0xWork      — token is in the 0xWork *verified* launch list (verified.json,
//                  pulled from 0xwork.org/launches). This is the authoritative
//                  signal, replacing the old (unreliable) per-token verified flag
//                  and the "any token-forge launch = 0xWork" heuristic.
//  • Clanker     — token is in the Clanker live-pool set (clanker.json, pulled
//                  from the Clanker API + v4 factory).
//  • Bankr       — any other shared-hook launch (on-chain hook / unverified forge).
//  • Independent — unknown source.
// Both 0xWork and Clanker are membership-based, so they survive a re-index.
const PLATFORM_STYLE = {
  "0xWork": { bg: "rgba(255,90,0,.14)", border: "rgba(255,90,0,.4)", color: "#ff8a3d" },
  Clanker: { bg: "rgba(46,204,143,.14)", border: "rgba(46,204,143,.4)", color: "#3fd79b" },
  Bankr: { bg: "rgba(90,140,255,.14)", border: "rgba(90,140,255,.4)", color: "#7da6ff" },
  Independent: { bg: "rgba(255,255,255,.06)", border: "rgba(255,255,255,.16)", color: "#b6b6ba" },
};
function tokenPlatform(t) {
  if (t.is0xWork) return "0xWork";
  if (t.isClanker || t.source === "clanker") return "Clanker";
  if (t.source === "onchain-hook" || t.source === "token-forge") return "Bankr";
  return "Independent";
}
// An agent's platform follows its tokens: 0xWork (verified) first, then Clanker,
// then any shared-hook launch (Bankr), else Independent.
function agentPlatform(a) {
  if (a.tokens.some((t) => t.is0xWork)) return "0xWork";
  if (a.tokens.some((t) => t.isClanker || t.source === "clanker")) return "Clanker";
  if (a.tokens.some((t) => t.source === "onchain-hook" || t.source === "token-forge")) return "Bankr";
  return "Independent";
}

// Real token image: launcher avatar if present, else the DEXScreener token image.
// Falls back to a deterministic emoji (handled by the avatar components) when neither.
const tokenImage = (t) => t?.launcher?.image || t?.market?.imageUrl || t?.imageUrl || null;

// Display name: launcher name, else @handle, else the agent's best token name.
function agentDisplayName(a) {
  if (a.name) return a.name;
  if (a.handle) return a.handle.startsWith("@") ? a.handle : `@${a.handle}`;
  return a.best?.tokenName || "Agent";
}
// Ticker line shown under the name: the agent's best token symbol.
const agentTicker = (a) => (a.best?.tokenSymbol ? `$${a.best.tokenSymbol}` : null);

// Small pill showing the agent's platform source. Renders nothing for unlabeled
// (on-chain-only) launches so they carry no platform tag.
function PlatformBadge({ platform, size = "sm" }) {
  const s = PLATFORM_STYLE[platform];
  if (!s) return null;
  return (
    <span className={`af-plat af-plat-${size}`} style={{ background: s.bg, borderColor: s.border, color: s.color }}>
      {platform}
    </span>
  );
}

// Compact table row for a launching agent (Agents tab): AGENT (avatar · name /
// best-token $ticker) | FEES (total) | TXNS (total) | AGE (oldest token). Opens detail.
// `agent` is derived at runtime from the live feed (see buildAgents): only agents that have
// launched tokens with an active DEX pool and real fees/volume appear here.
function AgentCard({ agent: a, onOpen }) {
  const primary = agentDisplayName(a);
  const ticker = agentTicker(a);
  const age = ageLabel(a.oldestCreatedAt);
  return (
    <div className="af-trow" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}>
      <div className="af-tcell-agent">
        <PicAvatar src={tokenImage(a.best)} seed={a.best?.tokenAddress || a.key} size={40} />
        <div className="af-tname-wrap">
          <span className="af-tname">
            {primary}
            {a.verified && <span className="af-verified" title="verified X handle">✓</span>}
            {/* NEW badge is detail-only — kept out of list rows. */}
          </span>
          <span className="af-ttick">{ticker}</span>
        </div>
      </div>
      <div className="af-tfees">{fmtUsd(a.totalFees)}</div>
      <div className="af-ttxns">{fmtNum(a.totalTxns || 0)}</div>
      <div className="af-tage">{age}</div>
    </div>
  );
}

// Shared column header for both tables. FEES is the sortable column (toggles asc/desc).
function TableHead({ sortDesc, onToggleSort }) {
  return (
    <div className="af-thead">
      <span>AGENT</span>
      <button className="af-th-sort" onClick={onToggleSort} aria-label="Sort by fees">
        FEES <span className="af-th-arrow">{sortDesc ? "▼" : "▲"}</span>
      </button>
      <span className="af-th-r">TXNS</span>
      <span className="af-th-r">AGE</span>
    </div>
  );
}

// ── Icons ──
const IconX = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
const IconGlobe = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
  </svg>
);
const IconBell = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);
const IconRocket = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="M12 15l-3-3a22 22 0 0 1 8-10c2.5 0 4 1.5 4 4a22 22 0 0 1-9 9z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </svg>
);
const IconTarget = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" fill="currentColor" />
  </svg>
);
const IconTrend = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 17l6-6 4 4 7-7" /><path d="M14 8h6v6" />
  </svg>
);
const IconDollar = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M14.8 9.3A2.4 2.4 0 0 0 12.6 8h-1.2a2.1 2.1 0 0 0 0 4.2h1.2a2.1 2.1 0 0 1 0 4.2h-1.2a2.4 2.4 0 0 1-2.2-1.3M12 6.5v1.5M12 16v1.5" />
  </svg>
);
const IconSearch = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
  </svg>
);
const IconFilter = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 5h18M6 12h12M10 19h4" />
  </svg>
);
const IconDoc = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
  </svg>
);
const IconCal = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" />
  </svg>
);
const IconShare = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </svg>
);

const xUrlFor = (handle) => (handle ? `https://x.com/${handle.replace(/^@/, "")}` : null);

// Decorative mini sparkline for stat cards (no real data — a few preset shapes).
const SPARKS = [
  "0,18 9,13 17,15 25,8 34,11 43,5 52,9 62,3",
  "0,6 9,10 18,7 27,12 36,9 45,14 54,8 62,12",
  "0,14 10,15 18,9 27,11 35,6 44,9 53,4 62,7",
  "0,10 8,7 17,11 26,6 35,9 44,5 53,8 62,4",
];
function Sparkline({ variant = 0 }) {
  return (
    <svg className="af-spark" width="64" height="22" viewBox="0 0 62 22" fill="none" aria-hidden="true">
      <polyline points={SPARKS[variant % SPARKS.length]} stroke="#ff5a00" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Compact table row: AGENT (avatar · name / $ticker) | FEES | TXNS | AGE.
function TokenRow({ token: t, onOpen }) {
  const age = ageLabel(t.createdAt);
  return (
    <div className="af-trow" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}>
      <div className="af-tcell-agent">
        <Avatar token={t} size={40} />
        <div className="af-tname-wrap">
          <span className="af-tname">
            {t.tokenName}
            {t.is0xWork && <span className="af-verified" title="0xWork verified">✓</span>}
          </span>
          {/* Platform pill and NEW badge are intentionally detail-only — list rows stay clean. */}
          <span className="af-ttick">${t.tokenSymbol}</span>
        </div>
      </div>
      <div className="af-tfees">{t.market?.hasPool ? fmtUsd(t.fees) : "—"}</div>
      <div className="af-ttxns">{t.market?.hasPool ? fmtNum(t.market.txns24h || 0) : "—"}</div>
      <div className="af-tage">{age}</div>
    </div>
  );
}

// Subtle electric lightning streaks behind the page content.
const BOLTS = [
  { x: "9%", dur: 7.5, delay: 0.4, hue: "o" },
  { x: "23%", dur: 9.5, delay: 3.2, hue: "w" },
  { x: "38%", dur: 8.2, delay: 1.6, hue: "o" },
  { x: "52%", dur: 11, delay: 5.4, hue: "o" },
  { x: "67%", dur: 8.8, delay: 2.5, hue: "w" },
  { x: "81%", dur: 10.2, delay: 6.1, hue: "o" },
  { x: "94%", dur: 7.8, delay: 4.3, hue: "o" },
];
function Lightning() {
  return (
    <div className="af-bolts" aria-hidden="true">
      {BOLTS.map((b, i) => (
        <span
          key={i}
          className={`af-bolt ${b.hue}`}
          style={{ left: b.x, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` }}
        />
      ))}
    </div>
  );
}

export default function AgentFeed() {
  const [tab, setTab] = useState("all");
  const [tokens, setTokens] = useState(() => (snapshot.items || []).map((l) => makeToken(mapLaunch(l))));
  const [rpcDown, setRpcDown] = useState(false);
  const [selected, setSelected] = useState(null); // tokenAddress of open detail
  const [selectedAgentKey, setSelectedAgentKey] = useState(null); // open agent detail (agentKey)
  const [toasts, setToasts] = useState([]); // transient new-launch notifications
  const [query, setQuery] = useState(""); // search box
  const [platformFilter, setPlatformFilter] = useState("all"); // Agents tab platform filter
  const [feesSortDesc, setFeesSortDesc] = useState(true); // FEES column sort (default desc)
  const [timeFilter, setTimeFilter] = useState("all"); // All Tokens age filter: 24h/7d/30d/all
  const [splash, setSplash] = useState(true); // 2s intro splash
  const [splashFade, setSplashFade] = useState(false);

  // Intro splash: hold 2s, fade out, then unmount.
  useEffect(() => {
    const t1 = setTimeout(() => setSplashFade(true), 2000);
    const t2 = setTimeout(() => setSplash(false), 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const lastBlock = useRef(snapshot.latestBlock || 0);
  const tokensRef = useRef(tokens);
  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  const pushToast = (text) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [{ id, text }, ...prev].slice(0, 4));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
  };

  function applyMarkets(markets) {
    setTokens((prev) =>
      prev.map((t) => {
        const m = markets[t.tokenAddress.toLowerCase()];
        if (!m) return t;
        return { ...t, market: m, fees: computeFees(m.volume24h) };
      })
    );
  }

  // Initial market load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Newest-first: the default view sorts unpriced tokens by recency, so the
        // tokens visible at the top of the list get their prices first.
        const addrs = [...tokensRef.current]
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .map((t) => t.tokenAddress);
        // Progressive: paint each 30-token batch as it arrives instead of waiting
        // for the whole ~478-token sweep (which made first load take ~1 min / stall).
        await fetchMarketsProgressive(addrs, (partial) => {
          if (!cancelled) applyMarkets(partial);
        });
      } catch {
        /* retry on next poll */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll DEXScreener for trading data.
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const markets = await fetchMarkets(tokensRef.current.map((t) => t.tokenAddress));
        applyMarkets(markets);
      } catch {
        /* transient */
      }
    }, DEX_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  // Poll Base on-chain for new hook launches (PoolManager Initialize events).
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const latest = await getLatestBlock();
        setRpcDown(false);
        if (!lastBlock.current) lastBlock.current = latest - RUNTIME_LOOKBACK_BLOCKS;
        const from = Math.max(lastBlock.current + 1, latest - RUNTIME_LOOKBACK_BLOCKS);
        if (from > latest) return;
        const events = await fetchNewLaunches(from, latest);
        lastBlock.current = latest;

        const known = new Set(tokensRef.current.map((t) => t.tokenAddress.toLowerCase()));
        const fresh = events.filter((e) => !known.has(e.tokenAddress.toLowerCase())).slice(0, MAX_NEW_PER_CYCLE);
        if (!fresh.length) return;

        const enriched = await Promise.all(
          fresh.map(async (e) => {
            const meta = await resolveTokenMeta(e.tokenAddress).catch(() => ({}));
            return makeToken({
              tokenName: meta.name || "New token",
              tokenSymbol: meta.symbol || "?",
              tokenAddress: e.tokenAddress,
              createdAt: new Date().toISOString().replace("T", " ").slice(0, 19),
              poolId: e.poolId,
              is0xWork: is0xWork(e.tokenAddress),
              isClanker: isClanker(e.tokenAddress),
              launcher: { name: null, handle: null, image: null, verified: is0xWork(e.tokenAddress) },
              feeRecipient: null,
              dexscreenerUrl: e.dexscreenerUrl,
              basescanUrl: e.basescanUrl,
              source: "onchain-hook",
            });
          })
        );
        setTokens((prev) => {
          const have = new Set(prev.map((t) => t.tokenAddress.toLowerCase()));
          const add = enriched.filter((t) => !have.has(t.tokenAddress.toLowerCase())).map((t) => ({ ...t, isNew: true }));
          return add.length ? [...add, ...prev] : prev;
        });
        enriched.forEach((t) =>
          pushToast(`🆕 ${t.tokenSymbol && t.tokenSymbol !== "?" ? `$${t.tokenSymbol}` : t.tokenName} just launched on-chain`)
        );
      } catch {
        setRpcDown(true);
      }
    }, LAUNCH_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  // ── derived ──
  const isNew = (t) => t.isNew || daysSince(t.createdAt) < NEW_DAYS;

  const newCount = tokens.filter(isNew).length;
  const totalVol = tokens.reduce((s, t) => s + (t.market?.volume24h || 0), 0);

  // Group tokens by agent for the detail view.
  const byAgent = useMemo(() => {
    const g = {};
    for (const t of tokens) (g[agentKey(t)] ??= []).push(t);
    return g;
  }, [tokens]);

  const q = query.trim().toLowerCase();

  const list = useMemo(() => {
    // Token search: name, ticker, or agent handle/name.
    const matches = (t) =>
      !q ||
      t.tokenName?.toLowerCase().includes(q) ||
      t.tokenSymbol?.toLowerCase().includes(q) ||
      (agentLabel(t) || "").toLowerCase().includes(q);
    const maxAge = { "24h": 1, "7d": 7, "30d": 30, all: Infinity }[timeFilter];
    const inWindow = (t) => daysSince(t.createdAt) <= maxAge;
    // Sort by fees (direction from the FEES header), newest-first as the tiebreak.
    const dir = feesSortDesc ? 1 : -1;
    const key = (t) => t.fees || 0;
    return [...tokens]
      .filter((t) => matches(t) && inWindow(t))
      .sort((a, b) => dir * (key(b) - key(a)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [tokens, q, timeFilter, feesSortDesc]);

  // Ticker shows only the top tokens by fees so the loop is short and readable —
  // scrolling all ~478 made it whip by too fast to read any symbol.
  const tickerTokens = useMemo(
    () => [...tokens].sort((a, b) => (b.fees || 0) - (a.fees || 0)).slice(0, 40),
    [tokens]
  );

  // Agents derived from the live feed (tokens with active pools + real fees/volume).
  const agents = useMemo(() => buildAgents(tokens), [tokens]);

  // Agent search: name, handle, or any of their token names/tickers.
  const agentList = useMemo(() => {
    const dir = feesSortDesc ? 1 : -1;
    return agents
      .filter(
        (a) =>
          (platformFilter === "all" || agentPlatform(a) === platformFilter) &&
          (!q ||
            (a.name || "").toLowerCase().includes(q) ||
            (a.handle || "").toLowerCase().includes(q) ||
            a.tokens.some((t) => t.tokenSymbol?.toLowerCase().includes(q) || t.tokenName?.toLowerCase().includes(q)))
      )
      .sort((x, y) => dir * (y.totalFees - x.totalFees));
  }, [agents, q, platformFilter, feesSortDesc]);

  const selectedToken = selected && tokens.find((t) => t.tokenAddress.toLowerCase() === selected.toLowerCase());
  const selectedAgent = selectedAgentKey != null && agents.find((a) => a.key === selectedAgentKey);

  // Open a token by address: known token → detail modal, otherwise DEXScreener.
  const openToken = (addr) => {
    const known = tokensRef.current.find((t) => t.tokenAddress.toLowerCase() === addr.toLowerCase());
    if (known) setSelected(known.tokenAddress);
    else window.open(`https://dexscreener.com/base/${addr}`, "_blank", "noopener");
  };

  // Lock body scroll while modal is open + close on Escape.
  useEffect(() => {
    if (!selectedToken) return;
    const onKey = (e) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [selectedToken]);

  // Lock body scroll while the agent detail is open + close on Escape.
  useEffect(() => {
    if (!selectedAgent) return;
    const onKey = (e) => e.key === "Escape" && setSelectedAgentKey(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [selectedAgent]);

  return (
    <div className="af-root">
      <style>{CSS}</style>
      <Lightning />

      {splash && (
        <div className={`af-splash ${splashFade ? "fade" : ""}`}>
          <img className="af-splash-logo" src="/agentfeed/logo.png" alt="Feedr" />
          <div className="af-splash-word">FEEDR</div>
        </div>
      )}

      <header className="af-header">
        <span className="af-logo">
          <img src="/agentfeed/logo.png" height="36" alt="Feedr" />
          <span className="af-logo-word">Feedr</span>
        </span>
        <button className="af-bell" aria-label="notifications"><IconBell /></button>
      </header>
      <div className="af-glowline" aria-hidden="true" />

      <div className="af-tagline">The <span className="af-tagline-hl">live intelligence layer</span> for AI agent tokens on Base.</div>

      <div className="af-ticker" aria-hidden="true">
        <div className="af-ticker-track">
          {[...tickerTokens, ...tickerTokens].map((t, i) => (
            <span className="af-tk-item" key={i}>
              <span className="af-tk-emoji">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ verticalAlign: "-1px" }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="#6b6b72" strokeWidth="2" />
                  <circle cx="12" cy="12" r="3.4" fill="#6b6b72" />
                </svg>
              </span>
              <span className="af-tk-sym">${t.tokenSymbol}</span>
              <span className="af-tk-val">{t.market?.hasPool ? fmtUsd(t.fees) : "—"}</span>
              <span className="af-tk-sep">•</span>
            </span>
          ))}
        </div>
      </div>

      <div className="af-statwrap">
        <div className="af-stat-radial" aria-hidden="true" />
        <div className="af-statbar">
          <div className="af-stat">
            <span className="af-stat-ico"><IconRocket /></span>
            <div className="af-stat-num">{tokens.length}</div>
            <div className="af-stat-lbl">Tokens Launched</div>
            <Sparkline variant={0} />
          </div>
          <div className="af-stat">
            <span className="af-stat-ico"><IconTarget /></span>
            <div className="af-stat-num">{agents.length}</div>
            <div className="af-stat-lbl">Agents Tracked</div>
            <Sparkline variant={1} />
          </div>
          <div className="af-stat">
            <span className="af-stat-ico"><IconTrend /></span>
            <div className="af-stat-num">{newCount}</div>
            <div className="af-stat-lbl">New This Week</div>
            <Sparkline variant={2} />
          </div>
          <div className="af-stat">
            <span className="af-stat-ico"><IconDollar /></span>
            <div className="af-stat-num">{fmtUsd(totalVol)}</div>
            <div className="af-stat-lbl">24h Volume</div>
            <Sparkline variant={3} />
          </div>
        </div>
      </div>

      {rpcDown && (
        <div className="af-note">ℹ️ On-chain launch polling paused (Base RPC unreachable) — showing the snapshot. Trading data is still live.</div>
      )}

      <div className="af-tabs">
        <button className={`af-tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>
          All Tokens <span className="af-tab-count">{tokens.length}</span>
        </button>
        <button className={`af-tab ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>
          Agents <span className="af-tab-count">{agents.length}</span>
        </button>
      </div>

      <div className="af-search">
        <div className="af-search-box">
          <span className="af-search-icon"><IconSearch /></span>
          <input
            className="af-search-input"
            type="text"
            placeholder={tab === "agents" ? "Search agents by name or handle…" : "Search by token name, ticker, or agent…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button className="af-search-clear" onClick={() => setQuery("")} aria-label="clear">✕</button>
          ) : (
            <span className="af-search-filter" aria-hidden="true"><IconFilter /></span>
          )}
        </div>
      </div>

      {tab === "agents" ? (
        <div className="af-list">
          {agents.length > 0 && (
            <div className="af-plat-filter" role="group" aria-label="Filter agents by platform">
              {["all", "0xWork", "Clanker", "Bankr", "Independent"].map((p) => (
                <button
                  key={p}
                  className={`af-plat-fbtn ${platformFilter === p ? "active" : ""}`}
                  onClick={() => setPlatformFilter(p)}
                >
                  {p === "all" ? "All" : p}
                </button>
              ))}
            </div>
          )}
          <div className="af-table">
            <TableHead sortDesc={feesSortDesc} onToggleSort={() => setFeesSortDesc((v) => !v)} />
            {agentList.length === 0 && (
              <div className="af-empty">
                {query ? `No agents match “${query}”.` : "No agents with active pools and fees yet — loading live data…"}
              </div>
            )}
            {agentList.map((a) => (
              <AgentCard key={a.key} agent={a} onOpen={() => setSelectedAgentKey(a.key)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="af-list">
          <div className="af-plat-filter" role="group" aria-label="Filter tokens by age">
            {[["24h", "24H"], ["7d", "7D"], ["30d", "30D"], ["all", "ALL"]].map(([v, label]) => (
              <button
                key={v}
                className={`af-plat-fbtn ${timeFilter === v ? "active" : ""}`}
                onClick={() => setTimeFilter(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="af-table">
            <TableHead sortDesc={feesSortDesc} onToggleSort={() => setFeesSortDesc((v) => !v)} />
            {list.length === 0 && <div className="af-empty">No tokens match “{query}”.</div>}
            {list.map((t) => (
              <TokenRow key={t.tokenAddress} token={t} onOpen={() => setSelected(t.tokenAddress)} />
            ))}
          </div>
        </div>
      )}

      <footer className="af-footer">
        <div className="af-foot-main">
          <div className="af-foot-brand">
            <img src="/agentfeed/logo.png" height="32" alt="Feedr" />
            <p className="af-foot-tag">The live token feed for onchain AI agents.</p>
          </div>
          <nav className="af-foot-links">
            <a href="https://docs.base.org" target="_blank" rel="noreferrer">Docs</a>
            <a href="https://discord.com" target="_blank" rel="noreferrer">Discord</a>
            <a href="https://x.com" target="_blank" rel="noreferrer">X (Twitter)</a>
          </nav>
        </div>
        <div className="af-foot-bottom">
          <span>© 2026 Feedr</span>
          <span className="af-foot-fine">{tokens.length} tokens with live pools · indexed on-chain</span>
        </div>
      </footer>

      <div className="af-toasts">
        {toasts.map((t) => (
          <div key={t.id} className="af-toast">{t.text}</div>
        ))}
      </div>

      {selectedToken && (
        <TokenDetail
          token={selectedToken}
          siblings={(byAgent[agentKey(selectedToken)] || []).filter((s) => s.tokenAddress !== selectedToken.tokenAddress)}
          onClose={() => setSelected(null)}
          onPick={(addr) => setSelected(addr)}
          isNew={isNew}
          pushToast={pushToast}
        />
      )}

      {selectedAgent && (
        <AgentDetail agent={selectedAgent} onClose={() => setSelectedAgentKey(null)} onPickToken={openToken} pushToast={pushToast} />
      )}
    </div>
  );
}

/* ─────────────────── Agent detail (Feedr style) ─────────────────── */
// Profile for a launching agent, derived from the live feed. Banner + lightning,
// orange-ringed avatar, fee-based tier, launch/fees/volume/best-token stats, the
// agent's full token grid, and community reviews. No 0xWork task/reputation data.
function AgentDetail({ agent: a, onClose, onPickToken, pushToast }) {
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState(null);
  const tier = tierForFees(a.totalFees);
  const tierColor = TIER_COLOR[tier];
  const platform = agentPlatform(a);
  const handle = a.handle ? (a.handle.startsWith("@") ? a.handle : `@${a.handle}`) : null;

  // Generate the agent share card and open a preview before sharing/downloading.
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const blob = await buildAgentShareCard(a);
      const name = `feedr-agent-${(a.name || "agent").replace(/\W+/g, "")}.png`;
      setPreview({ blob, name, url: URL.createObjectURL(blob) });
    } catch {
      pushToast?.("Couldn't generate share card");
    } finally {
      setSharing(false);
    }
  };

  const closePreview = () =>
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });

  return (
    <div className="af-agpage">
      <div className="af-agpage-inner">
        <div className="af-ag-topbar">
          <button className="af-ag-back" onClick={onClose}>← Back</button>
          <button className="af-act share" onClick={share} disabled={sharing}>
            <IconShare /> {sharing ? "Generating…" : "Share"}
          </button>
        </div>

        <div className="af-ag-card">
          <div className="af-ag-banner" aria-hidden="true">
            <span className="af-ag-bolt b1" />
            <span className="af-ag-bolt b2" />
            <span className="af-ag-bolt b3" />
          </div>
          <div className="af-ag-headrow">
            <div className="af-ag-avwrap ring">
              <PicAvatar src={tokenImage(a.best)} seed={a.best?.tokenAddress || a.key} size={104} />
            </div>
            <div className="af-ag-id">
              <div className="af-ag-namerow">
                <span className="af-ag-name">{agentDisplayName(a)}</span>
                {a.verified && <span className="af-verified" title="verified X handle">✓</span>}
                <span className="af-ag-tier" style={{ background: tierColor }}>{tier.toUpperCase()}</span>
                {/* NEW badge: detail-only (kept out of list rows), driven by the agent's newest token. */}
                {daysSince(a.newestCreatedAt) < NEW_DAYS && <span className="af-new-badge">NEW</span>}
              </div>
              <div className="af-ag-submeta">
                {a.name && handle ? (
                  <a className="af-ag-handle" href={`https://x.com/${handle.replace(/^@/, "")}`} target="_blank" rel="noreferrer">
                    {handle}
                  </a>
                ) : agentTicker(a) ? (
                  <span className="af-ag-handle af-orange">{agentTicker(a)}</span>
                ) : null}
                <span className="af-ag-num">{a.tokensLaunched} TOKEN{a.tokensLaunched === 1 ? "" : "S"}</span>
              </div>
              <div className="af-ag-platrow">
                Launched via <PlatformBadge platform={platform} size="lg" />
              </div>
              {a.wallet && (
                <div className="af-ag-wallet">
                  <span className="af-ag-wallet-lbl">Wallet</span>
                  <span className="mono">{short(a.wallet)}</span>
                  <a className="af-link" href={`https://basescan.org/address/${a.wallet}`} target="_blank" rel="noreferrer">
                    BaseScan ↗
                  </a>
                </div>
              )}
            </div>
          </div>

          <div className="af-ag-stats">
            <div className="af-ag-stat">
              <div className="af-ag-stat-n">{a.tokensLaunched}</div>
              <div className="af-ag-stat-l">Tokens Launched</div>
            </div>
            <div className="af-ag-stat">
              <div className="af-ag-stat-n">{fmtUsd(a.totalFees)}</div>
              <div className="af-ag-stat-l">Total Fees Earned</div>
            </div>
            <div className="af-ag-stat">
              <div className="af-ag-stat-n">{fmtUsd(a.totalVolume)}</div>
              <div className="af-ag-stat-l">Total Volume</div>
            </div>
            <div className="af-ag-stat">
              <div className="af-ag-stat-n">${a.best.tokenSymbol}</div>
              <div className="af-ag-stat-l">Best Token</div>
            </div>
          </div>

          <div className="af-section-label">
            Tokens launched <span className="af-tab-count">{a.tokens.length}</span>
          </div>
          <div className="af-ag-tokens">
            {a.tokens.map((t) => (
              <button key={t.tokenAddress} className="af-ag-tok" onClick={() => onPickToken(t.tokenAddress)}>
                <Avatar token={t} size={34} />
                <div className="af-ag-tok-id">
                  <div className="af-ag-tok-name">{t.tokenName}</div>
                  <div className="af-ag-tok-sym">${t.tokenSymbol}</div>
                </div>
                <div className="af-ag-tok-stats">
                  <div className="af-ag-tok-price">{t.market?.priceUsd ? fmtUsd(t.market.priceUsd) : "—"}</div>
                  <div className="af-ag-tok-sub">
                    {fmtUsd(t.fees)} fees · {fmtUsd(t.market?.volume24h || 0)} vol
                  </div>
                </div>
              </button>
            ))}
          </div>

          <Community storeKey={`agent:${a.key}`} />
        </div>

        {preview && <SharePreview {...preview} onClose={closePreview} pushToast={pushToast} />}
      </div>
    </div>
  );
}

/* ─────────────────── Share card (client-side canvas) ─────────────────── */
// Load an image for canvas use. crossOrigin is requested so a CORS-clean image
// can be drawn+exported; if the host doesn't allow it the load fails and we
// resolve null (caller falls back) — this avoids tainting the canvas on export.
function loadImg(src, cors) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Load an image CORS-clean for canvas export. DEXScreener's image hosts don't send
// CORS headers, so a direct crossOrigin load fails (and would taint the canvas);
// fall back to a CORS-enabling image proxy so the real token image still draws.
async function loadCanvasImg(src) {
  if (!src) return null;
  const direct = await loadImg(src, true);
  if (direct) return direct;
  const proxied = `https://images.weserv.nl/?url=ssl:${encodeURIComponent(src.replace(/^https?:\/\//, ""))}`;
  return await loadImg(proxied, true);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Truncate text with an ellipsis to fit maxW at the ctx's current font.
function fitText(ctx, text, maxW) {
  text = String(text ?? "");
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

const SANS = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

// Premium gold palette for share cards.
const GOLD = "#d4a017";
const GOLD_LT = "#e8c25a";
const GOLD_DIM = "#b59a5a";

// Shared black/gold chrome: background, glowing gold border, "F·" logo tile,
// Feedr wordmark, a right-aligned tagline, and the centered @handle footer.
async function drawShareChrome(ctx, W, H, P, tagline) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const lin = ctx.createLinearGradient(0, 0, W, H);
  lin.addColorStop(0, "#0c0a04");
  lin.addColorStop(0.5, "#040403");
  lin.addColorStop(1, "#0c0a04");
  ctx.fillStyle = lin;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -40, 0, W / 2, -40, 680);
  glow.addColorStop(0, "rgba(212,160,23,0.16)");
  glow.addColorStop(1, "rgba(212,160,23,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Gold border with soft glow + inner hairline.
  ctx.save();
  ctx.shadowColor = "rgba(212,160,23,0.5)";
  ctx.shadowBlur = 26;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 2.5;
  roundRect(ctx, 18, 18, W - 36, H - 36, 26);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = "rgba(212,160,23,0.22)";
  ctx.lineWidth = 1;
  roundRect(ctx, 27, 27, W - 54, H - 54, 20);
  ctx.stroke();

  // Logo: the real brand image (logo.png), then wordmark + right tagline.
  const lh = 56, lyp = 44;
  let wordX = P;
  const logoImg = await loadImg("/agentfeed/logo.png", false);
  if (logoImg) {
    const lw = Math.round(lh * (logoImg.naturalWidth / logoImg.naturalHeight));
    ctx.drawImage(logoImg, P, lyp, lw, lh);
    wordX = P + lw + 14;
  }
  ctx.fillStyle = "#fff";
  ctx.font = `800 38px ${SANS}`;
  ctx.fillText("Feedr", wordX, lyp + 40);
  ctx.fillStyle = GOLD;
  ctx.font = `700 16px ${SANS}`;
  ctx.textAlign = "right";
  ctx.fillText(tagline, W - P, lyp + 36);
  ctx.textAlign = "left";

  // Footer: hairline + centered handle.
  ctx.strokeStyle = "rgba(212,160,23,0.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(P, H - 66);
  ctx.lineTo(W - P, H - 66);
  ctx.stroke();
  ctx.fillStyle = GOLD;
  ctx.font = `800 24px ${SANS}`;
  ctx.textAlign = "center";
  ctx.fillText(SHARE_HANDLE, W / 2, H - 34);
  ctx.textAlign = "left";
}

// A single gold/black stat box: emoji icon, value, label.
function drawStatBox(ctx, x, y, w, h, icon, label, val) {
  ctx.fillStyle = "#0c0a05";
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.strokeStyle = "rgba(212,160,23,0.35)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, x, y, w, h, 16);
  ctx.stroke();
  ctx.fillStyle = GOLD;
  roundRect(ctx, x, y, w, 3, 2);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "22px 'Segoe UI Emoji','Apple Color Emoji', sans-serif";
  ctx.fillText(icon, x + 18, y + 40);
  ctx.fillStyle = "#fff";
  ctx.font = `800 30px ${SANS}`;
  ctx.fillText(fitText(ctx, val, w - 36), x + 18, y + 88);
  ctx.fillStyle = GOLD_DIM;
  ctx.font = `700 13px ${SANS}`;
  ctx.fillText(label, x + 18, y + 115);
}

// Render a 1200×630 (X-friendly) share card for a token. Returns a PNG Blob.
async function buildShareCard(t) {
  const m = t.market;
  const W = 1200, H = 630, P = 56;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  await drawShareChrome(ctx, W, H, P, "LIVE AGENT TOKEN FEED");

  // Token avatar with a gold ring (real image if CORS-clean, else emoji).
  const avSize = 132, avX = P, avY = 150, avCx = avX + avSize / 2, avCy = avY + avSize / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
  ctx.clip();
  const avatar = await loadCanvasImg(tokenImage(t));
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = "#15110a";
    ctx.fillRect(avX, avY, avSize, avSize);
    // Single neutral placeholder coin (no per-token avatar).
    ctx.strokeStyle = "#6b6b72";
    ctx.lineWidth = avSize * 0.06;
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#6b6b72";
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Name, ticker, and 24h change pill.
  const tx = avX + avSize + 34;
  ctx.fillStyle = "#fff";
  ctx.font = `800 58px ${SANS}`;
  ctx.fillText(fitText(ctx, t.tokenName || "Unknown", W - P - tx), tx, avY + 54);
  ctx.font = `800 32px ${SANS}`;
  ctx.fillStyle = GOLD_LT;
  const tick = "$" + (t.tokenSymbol || "?");
  ctx.fillText(tick, tx, avY + 102);
  if (m?.hasPool && m.priceChange24h != null) {
    const up = m.priceChange24h >= 0;
    const label = (up ? "▲ " : "▼ ") + Math.abs(m.priceChange24h).toFixed(1) + "%";
    ctx.font = `700 22px ${SANS}`;
    const px = tx + ctx.measureText(tick).width + 18, py = avY + 78, ph = 34;
    const pw = ctx.measureText(label).width + 28;
    ctx.fillStyle = up ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.16)";
    roundRect(ctx, px, py, pw, ph, 17);
    ctx.fill();
    ctx.fillStyle = up ? "#22c55e" : "#ef4444";
    ctx.fillText(label, px + 14, py + 24);
  }

  // Stat boxes.
  const stats = [
    ["💲", "PRICE", m?.hasPool ? fmtUsd(m.priceUsd) : "—"],
    ["🔥", "24H FEES", m?.hasPool ? fmtUsd(t.fees) : "—"],
    ["📊", "24H VOLUME", m?.hasPool ? fmtUsd(m.volume24h) : "—"],
    ["💧", "LIQUIDITY", m?.hasPool ? fmtUsd(m.liquidityUsd) : "—"],
  ];
  const gridY = 320, gap = 20, cardW = (W - 2 * P - 3 * gap) / 4, cardH = 132;
  stats.forEach(([icon, label, val], i) => drawStatBox(ctx, P + i * (cardW + gap), gridY, cardW, cardH, icon, label, val));

  // Contract address.
  const caY = 506;
  ctx.fillStyle = GOLD_DIM;
  ctx.font = `700 18px ${SANS}`;
  ctx.fillText("CONTRACT", P, caY);
  ctx.fillStyle = "#e8e3d4";
  ctx.font = "600 24px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.fillText(short(t.tokenAddress), P + 132, caY);

  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );
}

// Render a 1200×630 share card for a launching agent. Returns a PNG Blob.
async function buildAgentShareCard(a) {
  const W = 1200, H = 630, P = 56;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  await drawShareChrome(ctx, W, H, P, "FEEDR AGENT");

  // Agent avatar with a large gold ring.
  const avSize = 132, avX = P, avY = 150, avCx = avX + avSize / 2, avCy = avY + avSize / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
  ctx.clip();
  const avatar = await loadCanvasImg(tokenImage(a.best) || a.image);
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = "#15110a";
    ctx.fillRect(avX, avY, avSize, avSize);
    // Single neutral placeholder coin (no per-agent avatar).
    ctx.strokeStyle = "#6b6b72";
    ctx.lineWidth = avSize * 0.06;
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#6b6b72";
    ctx.beginPath();
    ctx.arc(avCx, avCy, avSize * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(avCx, avCy, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Name, then a gold tier badge + token-count badge below.
  const tx = avX + avSize + 34;
  ctx.fillStyle = "#fff";
  ctx.font = `800 54px ${SANS}`;
  ctx.fillText(fitText(ctx, agentDisplayName(a), W - P - tx), tx, avY + 50);
  let lx = tx;
  const tier = tierForFees(a.totalFees);
  ctx.font = `800 20px ${SANS}`;
  const tlabel = tier.toUpperCase();
  const tpw = ctx.measureText(tlabel).width + 26;
  ctx.fillStyle = GOLD;
  roundRect(ctx, lx, avY + 76, tpw, 32, 9);
  ctx.fill();
  ctx.fillStyle = "#1a1408";
  ctx.fillText(tlabel, lx + 13, avY + 98);
  lx += tpw + 12;
  ctx.font = `700 20px ${SANS}`;
  const albl = a.tokensLaunched + (a.tokensLaunched === 1 ? " TOKEN" : " TOKENS");
  const apw = ctx.measureText(albl).width + 26;
  ctx.fillStyle = "rgba(212,160,23,0.14)";
  roundRect(ctx, lx, avY + 76, apw, 32, 9);
  ctx.fill();
  ctx.strokeStyle = "rgba(212,160,23,0.5)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, lx, avY + 76, apw, 32, 9);
  ctx.stroke();
  ctx.fillStyle = GOLD_LT;
  ctx.fillText(albl, lx + 13, avY + 98);
  lx += apw + 12;
  // Platform source pill.
  const plat = agentPlatform(a).toUpperCase();
  ctx.font = `700 20px ${SANS}`;
  const ppw = ctx.measureText(plat).width + 26;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, lx, avY + 76, ppw, 32, 9);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, lx, avY + 76, ppw, 32, 9);
  ctx.stroke();
  ctx.fillStyle = "#cfcfd4";
  ctx.fillText(plat, lx + 13, avY + 98);

  // Stat boxes with icons.
  const stats = [
    ["🚀", "TOKENS LAUNCHED", String(a.tokensLaunched)],
    ["💰", "TOTAL FEES", fmtUsd(a.totalFees)],
    ["📈", "TOTAL VOLUME", fmtUsd(a.totalVolume)],
    ["🏆", "BEST TOKEN", "$" + a.best.tokenSymbol],
  ];
  const gridY = 320, gap = 20, cardW = (W - 2 * P - 3 * gap) / 4, cardH = 132;
  stats.forEach(([icon, label, val], i) => drawStatBox(ctx, P + i * (cardW + gap), gridY, cardW, cardH, icon, label, val));

  // Wallet address (or best token name when the agent is anonymous).
  const caY = 506;
  ctx.fillStyle = GOLD_DIM;
  ctx.font = `700 18px ${SANS}`;
  const tag = a.wallet ? "WALLET" : "TOP TOKEN";
  ctx.fillText(tag, P, caY);
  ctx.fillStyle = "#e8e3d4";
  ctx.font = "600 24px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.fillText(a.wallet ? short(a.wallet) : a.best.tokenName, P + 140, caY);

  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );
}

/* ─────────────────── Share preview ─────────────────── */
// Shows the generated card so the user can review it, then share or download.
function SharePreview({ url, blob, name, onClose, pushToast }) {
  let canShareFiles;
  try {
    canShareFiles = !!navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: "image/png" })] });
  } catch {
    canShareFiles = false;
  }

  const download = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    pushToast?.("🖼️ Card downloaded");
  };

  const shareNative = async () => {
    try {
      const file = new File([blob], name, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Feedr", text: "via Feedr" });
      }
    } catch (err) {
      if (err?.name !== "AbortError") pushToast?.("Share cancelled");
    }
  };

  return (
    <div className="af-share-bg" onClick={onClose}>
      <div className="af-share-modal" onClick={(e) => e.stopPropagation()}>
        <button className="af-modal-x" onClick={onClose} aria-label="close">✕</button>
        <div className="af-share-head">Preview · share card</div>
        <img className="af-share-img" src={url} alt="Share card preview" />
        <div className="af-share-actions">
          {canShareFiles && <button className="af-share-btn primary" onClick={shareNative}>Share</button>}
          <button className={`af-share-btn ${canShareFiles ? "" : "primary"}`} onClick={download}>Download PNG</button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Community (comments + reviews) ─────────────────── */
const COMMENTS_PREFIX = "feedr:comments:";

function loadComments(key) {
  try {
    const v = JSON.parse(localStorage.getItem(COMMENTS_PREFIX + key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveComments(key, list) {
  try {
    localStorage.setItem(COMMENTS_PREFIX + key, JSON.stringify(list));
  } catch {
    /* storage full / blocked */
  }
}

// Anonymous wallet-style handle, e.g. 0x7f3a…9c2b.
function randWallet() {
  const hex = "0123456789abcdef";
  const r = (n) => Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]).join("");
  return `0x${r(4)}…${r(4)}`;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function Stars({ value, size = 13 }) {
  return (
    <span className="af-stars" style={{ fontSize: size }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= value ? "on" : "off"}>★</span>
      ))}
    </span>
  );
}

// Comments + 1-5 star reviews for a token or agent, persisted in localStorage.
function Community({ storeKey }) {
  const [comments, setComments] = useState(() => loadComments(storeKey));
  const [text, setText] = useState("");
  const [rating, setRating] = useState(5);
  const [hover, setHover] = useState(0);

  const post = () => {
    const body = text.trim();
    if (!body) return;
    const c = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: randWallet(), rating, text: body, ts: Date.now() };
    const next = [c, ...comments];
    setComments(next);
    saveComments(storeKey, next);
    setText("");
    setRating(5);
    setHover(0);
  };

  const avg = comments.length ? comments.reduce((s, c) => s + c.rating, 0) / comments.length : 0;

  return (
    <div className="af-comm">
      <div className="af-section-label">
        Community {comments.length > 0 && <span className="af-tab-count">{comments.length}</span>}
      </div>

      <div className="af-comm-avg">
        <span className="af-comm-avg-num">{comments.length ? avg.toFixed(1) : "—"}</span>
        <Stars value={Math.round(avg)} size={17} />
        <span className="af-comm-avg-count">{comments.length} review{comments.length === 1 ? "" : "s"}</span>
      </div>

      <div className="af-comm-form">
        <div className="af-comm-pick">
          <span className="af-comm-pick-lbl">Your rating</span>
          <span className="af-star-pick">
            {[1, 2, 3, 4, 5].map((i) => (
              <button
                key={i}
                type="button"
                className={`af-star-btn ${i <= (hover || rating) ? "on" : ""}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(0)}
                onClick={() => setRating(i)}
                aria-label={`${i} star${i === 1 ? "" : "s"}`}
              >★</button>
            ))}
          </span>
        </div>
        <textarea
          className="af-comm-input"
          placeholder="Share your thoughts…"
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="af-comm-post" onClick={post} disabled={!text.trim()}>Post</button>
      </div>

      {comments.length === 0 ? (
        <div className="af-comm-empty">No reviews yet — be the first.</div>
      ) : (
        <div className="af-comm-list">
          {comments.map((c) => (
            <div key={c.id} className="af-comm-item">
              <div className="af-comm-top">
                <span className="af-comm-name">{c.name}</span>
                <Stars value={c.rating} />
                <span className="af-comm-time">{timeAgo(c.ts)}</span>
              </div>
              <div className="af-comm-text">{c.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────── Detail modal ─────────────────── */
function TokenDetail({ token: t, siblings, onClose, onPick, isNew, pushToast }) {
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState(null);
  const m = t.market;
  const who = agentLabel(t);
  const xUrl = xUrlFor(t.launcher?.handle);
  const webUrl = t.launchUrl || t.launcher?.profileUrl || null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.tokenAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  // Generate the share card and open a preview so the user can review it
  // before sharing or downloading.
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const blob = await buildShareCard(t);
      const name = `feedr-${(t.tokenSymbol || "token").replace(/\W+/g, "")}.png`;
      setPreview({ blob, name, url: URL.createObjectURL(blob) });
    } catch {
      pushToast?.("Couldn't generate share card");
    } finally {
      setSharing(false);
    }
  };

  const closePreview = () =>
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });

  return (
    <div className="af-modal-bg" onClick={onClose}>
      <div className="af-modal af-tdetail" onClick={(e) => e.stopPropagation()}>

        {/* 1 · HEADER */}
        <div className="af-td-topbar">
          <button className="af-ag-back" onClick={onClose}>← Back</button>
        </div>
        <div className="af-td-header">
          <Avatar token={t} size={56} />
          <div className="af-td-id">
            <div className="af-td-name">
              {t.tokenName}
              <PlatformBadge platform={tokenPlatform(t)} />
              {isNew(t) && <span className="af-new-badge">NEW</span>}
            </div>
            <div className="af-td-tick">
              ${t.tokenSymbol}
              {t.is0xWork && <span className="af-verified">✓ 0xWork</span>}
            </div>
            {who && <div className="af-td-by">by {who}</div>}
          </div>
        </div>

        {/* 2 · SWAP */}
        {m?.hasPool && (
          <section className="af-td-section">
            <div className="af-td-label">Swap</div>
            <SwapBox token={t} pushToast={pushToast} />
          </section>
        )}

        {/* 3 · MARKET DATA */}
        <section className="af-td-section">
          <div className="af-td-label">Market Data</div>
          {m?.hasPool ? (
            <>
              <div className="af-market-grid">
                <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(m.priceUsd)}</div><div className="af-mkt-l">Price</div></div>
                <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(m.volume24h)}</div><div className="af-mkt-l">24h Volume</div></div>
                <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(m.liquidityUsd)}</div><div className="af-mkt-l">Liquidity</div></div>
                <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(t.fees)}</div><div className="af-mkt-l">Fees (24h est.)</div></div>
              </div>
              <div className="af-td-market-foot">
                <span className={`af-chg ${m.priceChange24h >= 0 ? "pos" : "neg"}`}>
                  {m.priceChange24h >= 0 ? "▲" : "▼"} {Math.abs(m.priceChange24h).toFixed(1)}% (24h)
                </span>
                <a className="af-dex-btn" href={dexUrl(t)} target="_blank" rel="noreferrer">Open on DEXScreener ↗</a>
              </div>
            </>
          ) : (
            <div className="af-nopool">No active pool yet — this token hasn’t started trading on a DEX.</div>
          )}
        </section>

        {/* 4 · TOKEN INFO */}
        <section className="af-td-section">
          <div className="af-td-label">Token Info</div>
          <div className="af-meta-row">
            <span className="af-k">Age</span>
            <span className="af-v">{ageLabel(t.createdAt)}</span>
          </div>
          <div className="af-meta-row">
            <span className="af-k">Launched</span>
            <span className="af-v">{fmtDate(t.createdAt)}</span>
          </div>
          <div className="af-meta-row">
            <span className="af-k">Token address</span>
            <span className="af-addr">
              <span className="mono">{short(t.tokenAddress)}</span>
              <button className="af-copy" onClick={copy}>{copied ? "copied ✓" : "copy"}</button>
              <a className="af-link" href={basescanUrl(t)} target="_blank" rel="noreferrer">BaseScan ↗</a>
            </span>
          </div>
          <div className="af-modal-links">
            <button className="af-act share" onClick={share} disabled={sharing}>
              <IconShare /> {sharing ? "Generating…" : "Share"}
            </button>
            {xUrl && <a className="af-act" href={xUrl} target="_blank" rel="noreferrer"><IconX /> X</a>}
            {webUrl && <a className="af-act" href={webUrl} target="_blank" rel="noreferrer"><IconGlobe /> Website</a>}
          </div>
        </section>

        {/* 5 · OTHER TOKENS BY THIS AGENT */}
        {siblings.length > 0 && (
          <section className="af-td-section">
            <div className="af-td-label">
              Other tokens by this agent <span className="af-tab-count">{siblings.length}</span>
            </div>
            <div className="af-td-hscroll">
              {siblings.slice(0, 12).map((s) => (
                <button key={s.tokenAddress} className="af-td-hcard" onClick={() => onPick(s.tokenAddress)}>
                  <Avatar token={s} size={36} />
                  <span className="af-td-hname">{s.tokenName}</span>
                  <span className="af-td-htick">
                    ${s.tokenSymbol}
                    {s.market?.hasPool && <span className="af-card-livedot" />}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* 6 · COMMUNITY */}
        <section className="af-td-section">
          <Community storeKey={`tok:${t.tokenAddress.toLowerCase()}`} />
        </section>

        {preview && <SharePreview {...preview} onClose={closePreview} pushToast={pushToast} />}
      </div>
    </div>
  );
}

/* ─────────────────── Swap widget ─────────────────── */
const SLIPPAGES = [0.5, 1, 3];

// Compact amount formatter for swap in/out values.
function fmtAmt(n) {
  if (!isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(n.toPrecision(5)).toString();
}

function SwapBox({ token: t, pushToast }) {
  const m = t.market;
  const [side, setSide] = useState("buy"); // buy = ETH→token, sell = token→ETH
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [swapping, setSwapping] = useState(false);
  const [done, setDone] = useState(false);

  const priceNative = m?.priceNative || 0; // token price in ETH
  const ethUsd = priceNative > 0 ? m.priceUsd / priceNative : 0;
  const amt = parseFloat(amount) || 0;

  // Output before slippage.
  const rawOut = side === "buy" ? (priceNative > 0 ? amt / priceNative : 0) : amt * priceNative;
  const minOut = rawOut * (1 - slippage / 100);
  const inSym = side === "buy" ? "ETH" : t.tokenSymbol;
  const outSym = side === "buy" ? t.tokenSymbol : "ETH";
  const inUsd = side === "buy" ? amt * ethUsd : amt * m.priceUsd;

  const reset = (next) => {
    setSide(next);
    setAmount("");
    setDone(false);
  };

  const swap = () => {
    if (!amt || swapping) return;
    setSwapping(true);
    setDone(false);
    setTimeout(() => {
      setSwapping(false);
      setDone(true);
      pushToast?.(`✅ Swapped ${fmtAmt(amt)} ${inSym} → ${fmtAmt(rawOut)} ${outSym}`);
      setTimeout(() => setDone(false), 2200);
    }, 1100);
  };

  return (
    <div className="af-swap">
      <div className="af-swap-tabs">
        <button className={`af-swap-tab buy ${side === "buy" ? "active" : ""}`} onClick={() => reset("buy")}>Buy</button>
        <button className={`af-swap-tab sell ${side === "sell" ? "active" : ""}`} onClick={() => reset("sell")}>Sell</button>
      </div>

      <div className="af-swap-field">
        <div className="af-swap-field-top">
          <span className="af-swap-lbl">You pay</span>
          <span className="af-swap-bal">{inSym}</span>
        </div>
        <input
          className="af-swap-input"
          type="number"
          inputMode="decimal"
          min="0"
          placeholder="0.0"
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setDone(false); }}
        />
        <div className="af-swap-sub">{inUsd > 0 ? `≈ ${fmtUsd(inUsd)}` : " "}</div>
      </div>

      <div className="af-swap-arrow">↓</div>

      <div className="af-swap-field">
        <div className="af-swap-field-top">
          <span className="af-swap-lbl">You receive</span>
          <span className="af-swap-bal">{outSym}</span>
        </div>
        <div className="af-swap-output">{fmtAmt(rawOut)}</div>
        <div className="af-swap-sub">{rawOut > 0 ? `min ${fmtAmt(minOut)} after ${slippage}% slippage` : " "}</div>
      </div>

      <div className="af-swap-slip">
        <span className="af-swap-lbl">Slippage</span>
        <div className="af-slip-opts">
          {SLIPPAGES.map((s) => (
            <button key={s} className={`af-slip ${slippage === s ? "active" : ""}`} onClick={() => setSlippage(s)}>{s}%</button>
          ))}
        </div>
      </div>

      <div className="af-swap-rate">1 {t.tokenSymbol} ≈ {fmtUsd(m.priceUsd)}</div>

      <button className={`af-swap-btn ${side} ${done ? "done" : ""}`} disabled={!amt || swapping} onClick={swap}>
        {swapping ? "Swapping…" : done ? "✓ Swap complete" : amt ? `${side === "buy" ? "Buy" : "Sell"} ${t.tokenSymbol}` : "Enter an amount"}
      </button>
    </div>
  );
}

/* ─────────────────────── CSS ─────────────────────── */
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background:#0a0f05; }
  ::-webkit-scrollbar { width:6px; height:6px; background:#000; }
  ::-webkit-scrollbar-thumb { background:#2a2a2a; border-radius:4px; }

  .af-root { background:radial-gradient(ellipse 120% 90% at 50% 22%, #000000 0%, #05080a 42%, #0a0f05 100%); background-attachment:fixed; min-height:100vh; font-family:'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#fff; isolation:isolate; }

  /* Electric lightning streaks behind content */
  .af-bolts { position:fixed; inset:0; z-index:-1; pointer-events:none; overflow:hidden; }
  .af-bolt { position:absolute; top:0; width:2px; height:34vh; opacity:0; transform:translateY(-44vh);
    animation-name:af-strike; animation-timing-function:linear; animation-iteration-count:infinite; will-change:transform,opacity; }
  .af-bolt.o { background:linear-gradient(to bottom, rgba(255,150,70,0) 0%, rgba(255,150,70,.55) 44%, rgba(255,214,176,.95) 50%, rgba(255,150,70,.55) 56%, rgba(255,150,70,0) 100%); filter:drop-shadow(0 0 5px rgba(255,140,60,.5)); }
  .af-bolt.w { background:linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,.5) 44%, rgba(255,255,255,.92) 50%, rgba(255,255,255,.5) 56%, rgba(255,255,255,0) 100%); filter:drop-shadow(0 0 5px rgba(255,255,255,.45)); }
  @keyframes af-strike {
    0% { transform:translateY(-44vh); opacity:0; }
    4% { opacity:0; }
    5% { opacity:.75; }
    6% { opacity:.3; }
    7.5% { opacity:.7; }
    13% { transform:translateY(120vh); opacity:0; }
    100% { transform:translateY(120vh); opacity:0; }
  }
  @media (prefers-reduced-motion: reduce) { .af-bolts { display:none; } }

  /* Intro splash */
  .af-splash { position:fixed; inset:0; z-index:200; background:radial-gradient(ellipse at center, #0a0f05 0%, #000 78%); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; transition:opacity .5s ease; }
  .af-splash.fade { opacity:0; pointer-events:none; }
  .af-splash-logo { width:160px; height:auto; animation:splashPop .6s cubic-bezier(.2,.8,.2,1); filter:drop-shadow(0 6px 30px rgba(255,90,0,.35)); }
  .af-splash-word { font-size:32px; font-weight:900; letter-spacing:7px; color:#fff; animation:fade .9s ease-out; }
  @keyframes splashPop { from{ opacity:0; transform:scale(.82); } to{ opacity:1; transform:scale(1); } }

  .af-header { display:flex; align-items:center; justify-content:space-between; padding:15px 20px; border-bottom:1px solid rgba(255,255,255,0.06); position:sticky; top:0; background:rgba(0,0,0,0.85); backdrop-filter:blur(12px); z-index:20; }
  .af-logo { display:inline-flex; align-items:center; gap:10px; }
  .af-logo-mark { border-radius:9px; flex-shrink:0; box-shadow:0 2px 12px rgba(255,90,0,.3); }
  .af-logo-word { font-size:20px; font-weight:800; letter-spacing:-0.6px; color:#fff; }
  .af-bell { display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:11px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#cfcfcf; cursor:pointer; transition:all .15s; }
  .af-bell:hover { color:#ff5a00; border-color:rgba(255,90,0,.4); background:rgba(255,90,0,.08); }

  /* Animated glow line under the header */
  .af-glowline { height:2px; width:100%; background:linear-gradient(90deg, transparent 0%, rgba(255,90,0,0) 20%, #ff5a00 50%, rgba(255,90,0,0) 80%, transparent 100%); background-size:60% 100%; background-repeat:no-repeat; animation:glowslide 3.4s linear infinite; }
  @keyframes glowslide { 0%{ background-position:-60% 0; } 100%{ background-position:160% 0; } }

  /* Tagline */
  .af-tagline { max-width:1200px; margin:0 auto; padding:18px 16px 4px; font-size:17px; font-weight:800; letter-spacing:-.3px; color:#fff; }
  @media(min-width:680px){ .af-tagline{ padding:20px 28px 6px; font-size:19px; } }
  .af-tagline-hl { color:#ff5a00; }

  /* Scrolling ticker */
  .af-ticker { margin-top:10px; overflow:hidden; background:#0a0a0a; border-top:1px solid rgba(255,255,255,0.06); border-bottom:1px solid rgba(255,255,255,0.06); white-space:nowrap; }
  .af-ticker-track { display:inline-flex; align-items:center; will-change:transform; animation:tkscroll 50s linear infinite; }
  .af-ticker:hover .af-ticker-track { animation-play-state:paused; }
  @keyframes tkscroll { from{ transform:translateX(0); } to{ transform:translateX(-50%); } }
  .af-tk-item { display:inline-flex; align-items:center; gap:7px; padding:9px 0; font-size:12px; }
  .af-tk-emoji { font-size:13px; }
  .af-tk-sym { color:#ff5a00; font-weight:800; }
  .af-tk-val { color:#fff; font-weight:600; }
  .af-tk-sep { color:#3a3a3a; margin:0 14px; }

  /* Stats */
  .af-statwrap { position:relative; max-width:1200px; margin:0 auto; overflow:hidden; }
  .af-stat-radial { position:absolute; top:-80px; right:-80px; width:360px; height:360px; border-radius:50%; background:radial-gradient(circle, rgba(255,90,0,0.20), rgba(255,90,0,0.07) 45%, transparent 68%); filter:blur(24px); pointer-events:none; z-index:0; }
  .af-statbar { position:relative; z-index:1; display:grid; grid-template-columns:repeat(2,1fr); gap:12px; padding:18px 16px 4px; }
  @media(min-width:680px){ .af-statbar{ padding:24px 28px 4px; gap:14px; } }
  .af-stat { position:relative; overflow:hidden; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:18px; transition:border-color .2s; }
  .af-stat:hover { border-color:rgba(255,90,0,.35); }
  .af-stat-ico { display:inline-flex; color:#ff5a00; margin-bottom:10px; }
  .af-stat-num { font-size:26px; font-weight:800; letter-spacing:-.5px; color:#fff; line-height:1; }
  .af-stat-lbl { font-size:10.5px; color:#8a8a8a; font-weight:600; letter-spacing:.9px; text-transform:uppercase; margin-top:6px; }
  .af-spark { position:absolute; bottom:12px; right:12px; opacity:0.55; }

  .af-note { margin:14px 16px 0; padding:9px 14px; background:rgba(255,90,0,.08); border:1px solid rgba(255,90,0,.28); border-radius:12px; color:#ffb37a; font-size:11px; max-width:1200px; }
  @media(min-width:680px){ .af-note{ margin:14px 28px 0; } }

  .af-tabs { display:flex; gap:8px; padding:16px 16px 4px; max-width:1200px; margin:0 auto; flex-wrap:wrap; }
  @media(min-width:680px){ .af-tabs{ padding:18px 28px 4px; } }
  .af-tab { padding:9px 16px; border:1px solid rgba(255,255,255,0.12); background:transparent; color:#9a9a9a; border-radius:100px; font-size:13px; font-weight:600; cursor:pointer; transition:all .18s; display:flex; align-items:center; gap:7px; font-family:inherit; }
  .af-tab:hover { border-color:rgba(255,255,255,0.25); color:#ddd; }
  .af-tab.active { background:#ff5a00; border-color:#ff5a00; color:#fff; box-shadow:0 2px 18px rgba(255,90,0,.4); }
  .af-tab-count { font-size:11px; font-weight:800; background:rgba(255,255,255,.12); border-radius:100px; padding:1px 8px; }
  .af-tab.active .af-tab-count { background:rgba(255,255,255,.25); }

  .af-grid { display:grid; grid-template-columns:1fr; gap:12px; padding:16px; max-width:1200px; margin:0 auto; }
  @media(min-width:560px){ .af-grid{ grid-template-columns:repeat(2,1fr); } }
  @media(min-width:900px){ .af-grid{ grid-template-columns:repeat(3,1fr); padding:16px 28px 28px; } }
  .af-empty { color:#666; font-size:13px; padding:40px; text-align:center; grid-column:1/-1; }

  .af-card { background:#141414; border:1px solid #232323; border-radius:18px; padding:16px; text-align:left; cursor:pointer; transition:border-color .2s, transform .12s, background .2s; font-family:inherit; color:inherit; display:flex; flex-direction:column; gap:14px; }
  .af-card:hover { border-color:#ff5a00; background:#171717; transform:translateY(-2px); }
  .af-card:active { transform:translateY(0); }
  .af-card-top { display:flex; align-items:center; gap:12px; }
  .af-card-id { flex:1; min-width:0; }
  .af-card-name { font-size:15px; font-weight:700; display:flex; align-items:center; gap:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-card-tick { font-size:12px; color:#7a7a7a; font-weight:700; margin-top:2px; display:flex; align-items:center; gap:5px; }
  .af-card-livedot { width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 7px #22c55e; flex-shrink:0; }
  .af-card-rows { display:flex; flex-direction:column; gap:7px; }
  .af-card-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .af-k { font-size:11px; color:#666; font-weight:600; }
  .af-v { font-size:12px; color:#cfcfcf; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:62%; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .af-new-badge { font-size:8px; font-weight:800; letter-spacing:1px; background:rgba(255,90,0,.16); color:#ff7a30; border:1px solid rgba(255,90,0,.4); border-radius:6px; padding:1px 6px; flex-shrink:0; }
  .af-verified { font-size:11px; font-weight:800; color:#22c55e; }

  .af-av-img { border-radius:50%; object-fit:cover; flex-shrink:0; background:#222; }
  .af-av-emoji { display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background:#1d1d1d; border:1px solid #2a2a2a; flex-shrink:0; line-height:1; }

  /* Token launch card (Bankr-style, compact, translucent on dark) */
  .af-card.token { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.10); color:#fff; gap:0; padding:0; overflow:hidden; border-radius:13px; }
  .af-card.token:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.20); transform:translateY(-2px); }
  .af-card.token:focus-visible { outline:2px solid #ff5a00; outline-offset:2px; }
  .af-tc-head { display:flex; align-items:center; gap:10px; padding:10px 12px 8px; }
  .af-tc-id { flex:1; min-width:0; }
  .af-tc-name { font-size:13px; font-weight:700; color:#f2f2f3; display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-tc-tick { font-size:11px; color:#8a8a90; font-weight:700; margin-top:1px; display:flex; align-items:center; gap:5px; }
  .af-card.token .af-verified { color:#22c55e; font-size:10px; }
  .af-tc-rows { display:flex; flex-direction:column; gap:5px; padding:8px 12px; border-top:1px solid rgba(255,255,255,0.07); border-bottom:1px solid rgba(255,255,255,0.07); background:rgba(255,255,255,0.02); }
  .af-tc-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .af-card.token .af-k { font-size:10.5px; color:#7c7c83; font-weight:600; }
  .af-card.token .af-v { font-size:11.5px; color:#d4d4d8; font-weight:600; max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-card.token .af-v.fees { color:#22c55e; font-weight:800; }
  .af-ca { display:flex; align-items:center; gap:6px; }
  .af-card.token .af-ca .mono { color:#cfcfcf; font-size:11px; }
  .af-ca-copy { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#aaa; border-radius:6px; width:20px; height:20px; font-size:10px; cursor:pointer; line-height:1; }
  .af-ca-copy:hover { color:#fff; border-color:#ff5a00; }
  .af-tc-actions { display:flex; gap:6px; padding:8px 12px 10px; }
  .af-act { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; color:#cfcfcf; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:5px 9px; text-decoration:none; transition:all .15s; }
  .af-act:hover { border-color:#ff5a00; color:#fff; background:rgba(255,255,255,0.10); }
  .af-act.ghost { margin-left:auto; color:#71717a; }
  button.af-act { font-family:inherit; cursor:pointer; }
  .af-act.share { background:rgba(255,90,0,0.14); border-color:rgba(255,90,0,0.4); color:#ff8a3d; }
  .af-act.share:hover { background:rgba(255,90,0,0.24); color:#fff; border-color:#ff5a00; }
  .af-act:disabled { opacity:0.6; cursor:default; }

  /* Share-card preview */
  .af-share-bg { position:fixed; inset:0; z-index:70; background:rgba(0,0,0,0.82); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; padding:20px; overflow-y:auto; animation:fade .18s ease-out; }
  .af-share-modal { position:relative; background:#121212; border:1px solid #262626; border-radius:20px; padding:20px; width:100%; max-width:620px; margin:auto; animation:rise .22s cubic-bezier(.2,.8,.2,1); }
  .af-share-head { font-size:10px; color:#777; font-weight:700; letter-spacing:1px; text-transform:uppercase; margin-bottom:12px; }
  .af-share-img { width:100%; height:auto; border-radius:12px; border:1px solid #2a2a2a; display:block; }
  .af-share-actions { display:flex; gap:10px; margin-top:16px; }
  .af-share-btn { flex:1; padding:13px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:rgba(255,255,255,0.05); color:#fff; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit; transition:all .15s; }
  .af-share-btn:hover { border-color:#ff5a00; background:rgba(255,90,0,0.1); }
  .af-share-btn.primary { background:#ff5a00; border-color:#ff5a00; color:#fff; }
  .af-share-btn.primary:hover { background:#e65200; }

  /* Community (comments + reviews) */
  .af-comm { margin-top:10px; }
  .af-ag-card .af-comm { padding:0 22px 24px; }
  .af-ag-card .af-comm .af-section-label { padding:0; }
  .af-comm-avg { display:flex; align-items:center; gap:11px; margin-bottom:14px; }
  .af-comm-avg-num { font-size:28px; font-weight:800; color:#fff; letter-spacing:-.5px; line-height:1; }
  .af-comm-avg-count { font-size:12px; color:#8a8a8a; font-weight:600; }
  .af-stars { display:inline-flex; gap:1px; line-height:1; }
  .af-stars .on { color:#ff5a00; }
  .af-stars .off { color:#3a3a32; }
  .af-comm-form { background:#141a0c; border:1px solid #232d18; border-radius:14px; padding:14px; margin-bottom:16px; }
  .af-comm-pick { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
  .af-comm-pick-lbl { font-size:10.5px; color:#8a8a8a; font-weight:700; text-transform:uppercase; letter-spacing:.6px; }
  .af-star-pick { display:inline-flex; gap:4px; }
  .af-star-btn { background:none; border:none; cursor:pointer; font-size:23px; line-height:1; color:#3a3a32; padding:0; transition:color .12s, transform .12s; font-family:inherit; }
  .af-star-btn:hover { transform:scale(1.12); }
  .af-star-btn.on { color:#ff5a00; }
  .af-comm-input { width:100%; background:#0e1207; border:1px solid #232d18; border-radius:10px; color:#fff; font-family:inherit; font-size:13px; padding:10px 12px; resize:vertical; outline:none; }
  .af-comm-input:focus { border-color:#ff5a00; }
  .af-comm-input::placeholder { color:#5a5a52; }
  .af-comm-post { margin-top:10px; background:#ff5a00; color:#fff; border:none; border-radius:10px; padding:10px 22px; font-size:13px; font-weight:800; cursor:pointer; font-family:inherit; transition:background .15s; }
  .af-comm-post:hover { background:#e65200; }
  .af-comm-post:disabled { background:#2a2a22; color:#666; cursor:default; }
  .af-comm-list { display:flex; flex-direction:column; gap:10px; }
  .af-comm-item { background:#141a0c; border:1px solid #232d18; border-radius:12px; padding:12px 14px; }
  .af-comm-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
  .af-comm-name { font-size:12px; font-weight:800; color:#ff8a3d; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .af-comm-time { font-size:11px; color:#7a7a72; margin-left:auto; }
  .af-comm-text { font-size:13px; color:#d4d8cc; line-height:1.5; word-break:break-word; white-space:pre-wrap; }
  .af-comm-empty { font-size:12px; color:#666; padding:10px 2px; }

  /* Redesigned token detail — clearly separated sections */
  .af-tdetail { padding:20px 22px 24px; }
  .af-td-topbar { margin-bottom:14px; }
  .af-td-header { display:flex; gap:14px; align-items:center; }
  .af-td-id { min-width:0; flex:1; }
  .af-td-name { font-size:21px; font-weight:800; letter-spacing:-.4px; color:#fff; display:flex; align-items:center; gap:8px; }
  .af-td-tick { font-size:13px; font-weight:800; color:#ff5a00; margin-top:3px; display:flex; align-items:center; gap:8px; }
  .af-td-tick .af-verified { color:#22c55e; font-weight:800; }
  .af-td-by { font-size:12px; color:#9a9a9e; font-weight:600; margin-top:4px; }
  .af-td-section { border-top:1px solid #1e2814; margin-top:20px; padding-top:20px; }
  .af-td-label { font-size:10px; color:#8a8a8a; font-weight:800; letter-spacing:1.2px; text-transform:uppercase; margin-bottom:12px; display:flex; align-items:center; gap:8px; }
  .af-td-section .af-swap { margin-top:0; }
  .af-td-section .af-comm { margin-top:0; }
  .af-td-section .af-comm .af-section-label { margin-top:0; }
  .af-td-market-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; flex-wrap:wrap; }
  .af-td-market-foot .af-chg { margin-top:0; }
  .af-td-market-foot .af-dex-btn { display:inline-block; margin-top:0; padding:11px 18px; }
  .af-td-hscroll { display:flex; gap:10px; overflow-x:auto; padding-bottom:6px; }
  .af-td-hcard { flex:0 0 auto; width:150px; display:flex; flex-direction:column; align-items:flex-start; gap:8px; background:#1a2010; border:1px solid #232d18; border-radius:12px; padding:12px; cursor:pointer; font-family:inherit; text-align:left; transition:border-color .15s, background .15s; }
  .af-td-hcard:hover { border-color:#ff5a00; background:#202816; }
  .af-td-hname { font-size:13px; font-weight:700; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  .af-td-htick { font-size:11px; font-weight:700; color:#ff5a00; display:flex; align-items:center; gap:6px; }

  /* Footer */
  .af-footer { border-top:1px solid #161616; padding:32px 20px 26px; max-width:1200px; margin:36px auto 0; }
  .af-foot-main { display:flex; flex-direction:column; gap:24px; justify-content:space-between; }
  @media(min-width:680px){ .af-foot-main{ flex-direction:row; align-items:flex-start; padding:0 8px; } }
  .af-foot-brand { max-width:340px; }
  .af-foot-tag { font-size:13px; color:#999; margin-top:12px; line-height:1.5; }
  .af-foot-powered { font-size:11px; color:#555; margin-top:14px; display:flex; flex-wrap:wrap; gap:7px; align-items:center; }
  .af-foot-powered a { color:#888; text-decoration:none; font-weight:600; }
  .af-foot-powered a:hover { color:#ff5a00; }
  .af-foot-links { display:flex; flex-direction:column; gap:11px; }
  .af-foot-links a { font-size:13px; color:#aaa; text-decoration:none; font-weight:600; transition:color .15s; }
  .af-foot-links a:hover { color:#fff; }
  .af-foot-bottom { display:flex; flex-wrap:wrap; gap:8px; justify-content:space-between; align-items:center; border-top:1px solid #161616; margin-top:26px; padding-top:18px; font-size:11px; color:#555; }
  @media(min-width:680px){ .af-foot-bottom{ padding-left:8px; padding-right:8px; } }
  .af-foot-fine { color:#444; }

  /* modal */
  .af-modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.72); backdrop-filter:blur(6px); z-index:50; display:flex; align-items:flex-start; justify-content:center; padding:24px 14px; overflow-y:auto; animation:fade .18s ease-out; }
  .af-modal { position:relative; background:#121212; border:1px solid #262626; border-radius:22px; padding:24px; width:100%; max-width:520px; margin:auto; animation:rise .22s cubic-bezier(.2,.8,.2,1); }
  .af-modal-x { position:absolute; top:16px; right:16px; width:30px; height:30px; border-radius:50%; border:1px solid #2a2a2a; background:#1a1a1a; color:#888; font-size:13px; cursor:pointer; transition:all .15s; }
  .af-modal-x:hover { color:#fff; border-color:#3a3a3a; }
  .af-modal-hdr { display:flex; gap:14px; align-items:center; padding-right:34px; }
  .af-modal-name { font-size:20px; font-weight:800; letter-spacing:-.4px; display:flex; align-items:center; gap:8px; }
  .af-modal-sub { font-size:13px; color:#888; font-weight:700; margin-top:3px; display:flex; align-items:center; gap:8px; }
  .af-modal-agent { font-size:12px; color:#ff5a00; font-weight:600; margin-top:4px; }

  .af-modal-meta { margin-top:18px; display:flex; flex-direction:column; gap:11px; border-top:1px solid #1e1e1e; padding-top:16px; }
  .af-meta-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .af-addr { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .af-copy { font-size:11px; font-weight:700; background:#1c1c1c; border:1px solid #2a2a2a; color:#bbb; border-radius:8px; padding:3px 9px; cursor:pointer; transition:all .15s; font-family:inherit; }
  .af-copy:hover { border-color:#ff5a00; color:#fff; }
  .af-link { font-size:11px; font-weight:700; color:#ff5a00; text-decoration:none; }
  .af-link:hover { text-decoration:underline; }

  .af-section-label { font-size:10px; color:#777; font-weight:700; letter-spacing:1px; text-transform:uppercase; margin:20px 0 11px; display:flex; align-items:center; gap:8px; }
  .af-market-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
  .af-mkt { background:#181818; border:1px solid #242424; border-radius:14px; padding:14px; }
  .af-mkt-n { font-size:18px; font-weight:800; letter-spacing:-.4px; }
  .af-mkt-l { font-size:10px; color:#777; font-weight:600; letter-spacing:.6px; text-transform:uppercase; margin-top:5px; }
  .af-chg { font-size:13px; font-weight:700; margin-top:12px; }
  .af-chg.pos { color:#22c55e; } .af-chg.neg { color:#ef4444; }
  .af-dex-btn { display:block; text-align:center; margin-top:14px; background:#ff5a00; color:#fff; font-size:13px; font-weight:700; padding:12px; border-radius:12px; text-decoration:none; transition:background .15s; }
  .af-dex-btn:hover { background:#e65200; }
  .af-nopool { background:#181818; border:1px dashed #2e2e2e; border-radius:14px; padding:18px; color:#888; font-size:13px; text-align:center; margin-top:6px; }

  .af-sib-list { display:flex; flex-direction:column; gap:7px; }
  .af-sib { display:flex; align-items:center; gap:10px; background:#181818; border:1px solid #242424; border-radius:12px; padding:9px 12px; cursor:pointer; transition:border-color .15s, background .15s; font-family:inherit; text-align:left; }
  .af-sib:hover { border-color:#ff5a00; background:#1c1c1c; }
  .af-sib-name { flex:1; font-size:13px; font-weight:700; color:#eee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-sib-tick { font-size:11px; color:#777; font-weight:700; }
  .af-sib-more { font-size:11px; color:#666; padding:6px 4px; text-align:center; }
  .af-nosib { font-size:12px; color:#666; padding:6px 2px; }

  .af-search { max-width:1200px; margin:8px auto 0; padding:0 16px; }
  @media(min-width:680px){ .af-search{ padding:0 28px; } }
  .af-search-box { display:flex; align-items:center; gap:11px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:13px; padding:12px 14px; transition:border-color .15s; }
  .af-search-box:focus-within { border-color:#ff5a00; }
  .af-search-icon { display:inline-flex; color:#7a7a7a; flex-shrink:0; }
  .af-search-input { flex:1; min-width:0; background:transparent; border:none; color:#fff; font-size:14px; font-family:inherit; outline:none; }
  .af-search-input::placeholder { color:#5a5a5a; }
  .af-search-filter { display:inline-flex; color:#7a7a7a; flex-shrink:0; }
  .af-search-clear { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#aaa; border-radius:8px; width:26px; height:26px; cursor:pointer; font-size:11px; flex-shrink:0; }
  .af-search-clear:hover { color:#fff; border-color:#ff5a00; }

  /* Token list (rows) */

  .af-list { max-width:1200px; margin:12px auto 0; padding:0 16px 28px; }
  @media(min-width:680px){ .af-list{ padding:0 28px 32px; } }
  .af-list .af-empty { color:#666; font-size:13px; padding:40px; text-align:center; }
  /* Token + agent cards: dark olive-green with a subtle darker-green border. */
  .af-row { display:flex; align-items:center; gap:13px; padding:13px 14px; background:linear-gradient(135deg, #1a0a0a 0%, #1a2410 50%, #1a0a0a 100%); border:1px solid #0e1307; border-radius:10px; margin-bottom:8px; cursor:pointer; transition:background .15s, border-color .15s, transform .1s; font-family:inherit; }
  .af-row:hover { background:linear-gradient(135deg, #240f0f 0%, #243216 50%, #240f0f 100%); border-color:#2a3a1a; transform:translateX(2px); }
  .af-row:focus-visible { outline:2px solid #ff5a00; outline-offset:2px; }
  .af-row .af-av-img, .af-row .af-av-emoji { flex-shrink:0; }
  .af-row-mid { flex:1; min-width:0; }
  .af-row-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .af-row-name { font-size:14px; font-weight:800; color:#ffffff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:55vw; }
  .af-row-tick { font-size:12px; font-weight:700; color:#ff5a00; margin-top:2px; }
  .af-orange { color:#ff5a00; }
  .af-row .af-verified { font-size:11px; font-weight:800; color:#22c55e; }
  .af-row-meta { display:flex; align-items:center; gap:14px; margin-top:5px; font-size:11px; color:#9a9a9e; font-weight:500; }
  .af-row-chip { display:inline-flex; align-items:center; gap:5px; color:#9a9a9e; }
  .af-row-chip .mono { color:#9a9a9e; }
  .af-row-chip svg { color:#7c7c80; flex-shrink:0; }
  .af-row-right { text-align:right; flex-shrink:0; }
  .af-row-fees { font-size:15px; font-weight:800; color:#ff5a00; letter-spacing:-.3px; }
  .af-row-fired { font-size:11px; font-weight:700; color:#ffffff; margin-top:2px; }

  /* ── Compact table layout (All Tokens + Agents) ── */
  .af-table { display:flex; flex-direction:column; }
  .af-thead, .af-trow { display:grid; grid-template-columns:1fr 76px 52px 44px; align-items:center; gap:6px; }
  @media(min-width:680px){ .af-thead, .af-trow { grid-template-columns:1fr 120px 90px 70px; gap:14px; } }
  .af-thead { padding:6px 12px; font-size:11px; font-weight:800; letter-spacing:.6px; color:#8a8a8a; border-bottom:1px solid rgba(255,255,255,.1); }
  .af-th-r { text-align:right; }
  .af-th-sort { display:inline-flex; align-items:center; justify-content:flex-end; gap:4px; background:none; border:0; padding:0; margin:0; font:inherit; font-size:11px; font-weight:800; letter-spacing:.6px; color:#8a8a8a; cursor:pointer; text-align:right; }
  .af-th-sort:hover { color:#fff; }
  .af-th-arrow { color:#ff5a00; font-size:9px; }
  .af-trow { padding:9px 12px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.05); transition:background .12s; font-family:inherit; text-align:left; }
  .af-trow:hover { background:rgba(255,255,255,.035); }
  .af-trow:focus-visible { outline:2px solid #ff5a00; outline-offset:-2px; }
  .af-tcell-agent { display:flex; align-items:center; gap:11px; min-width:0; }
  .af-tcell-agent .af-av-img, .af-tcell-agent .af-av-emoji { flex-shrink:0; }
  .af-tname-wrap { flex:1; min-width:0; display:flex; flex-direction:column; }
  .af-tname { display:flex; align-items:center; gap:6px; font-size:14px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .af-tname .af-verified { font-size:11px; font-weight:800; color:#22c55e; flex-shrink:0; }
  .af-ttick { font-size:12px; font-weight:700; color:#ff5a00; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .af-tfees { text-align:right; font-size:14px; font-weight:800; color:#ff5a00; letter-spacing:-.3px; }
  .af-ttxns { text-align:right; font-size:13px; font-weight:600; color:#c8c8cc; }
  .af-tage { text-align:right; font-size:13px; font-weight:600; color:#9a9a9e; }
  .af-tage.new { color:#ff5a00; font-weight:800; }

  .af-modal-links { display:flex; gap:8px; margin-top:12px; }

  .af-status { font-size:9px; font-weight:800; letter-spacing:.5px; border-radius:100px; padding:2px 8px; flex-shrink:0; text-transform:uppercase; }
  .af-status.on { background:rgba(34,197,94,.14); color:#22c55e; border:1px solid rgba(34,197,94,.3); }
  .af-status.off { background:rgba(255,255,255,0.06); color:#888; border:1px solid rgba(255,255,255,0.12); }
  .af-token-chip { background:rgba(255,90,0,0.1); border:1px solid rgba(255,90,0,0.28); color:#ff8a3d; border-radius:7px; padding:2px 7px; font-size:11px; font-weight:700; cursor:pointer; font-family:inherit; transition:all .15s; }
  .af-token-chip:hover { border-color:#ff5a00; color:#fff; background:rgba(255,90,0,0.22); }

  /* Agent detail page (0xWork profile style) */
  .af-agpage { position:fixed; inset:0; z-index:55; background:#000; overflow-y:auto; animation:fade .18s ease-out; }
  .af-agpage-inner { max-width:760px; margin:0 auto; padding:18px 16px 48px; }
  .af-ag-topbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
  .af-ag-back { display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); color:#cfcfcf; font-size:13px; font-weight:700; padding:9px 16px; border-radius:100px; cursor:pointer; font-family:inherit; transition:all .15s; }
  .af-ag-back:hover { color:#fff; border-color:rgba(255,90,0,.5); background:rgba(255,90,0,.08); }
  .af-ag-card { background:#0f0f0f; border:1px solid rgba(255,255,255,0.08); border-radius:20px; overflow:hidden; }
  .af-ag-banner { height:150px; background:linear-gradient(120deg, #0a0703 0%, #1c0d03 45%, #2a1206 100%); position:relative; overflow:hidden; }
  .af-ag-banner::after { content:""; position:absolute; inset:0; background:radial-gradient(circle at 78% 8%, rgba(255,90,0,.4), transparent 58%); }
  .af-ag-bolt { position:absolute; top:-12%; width:2px; height:130%; background:linear-gradient(180deg, transparent, rgba(255,140,60,.85), transparent); filter:blur(.4px); opacity:0; transform:skewX(-14deg); animation:agbolt 6s linear infinite; }
  .af-ag-bolt.b1 { left:24%; animation-delay:.6s; animation-duration:6.5s; }
  .af-ag-bolt.b2 { left:58%; animation-delay:2.4s; animation-duration:8s; background:linear-gradient(180deg, transparent, rgba(255,255,255,.7), transparent); }
  .af-ag-bolt.b3 { left:83%; animation-delay:4s; animation-duration:7.2s; }
  .af-ag-headrow { display:flex; gap:18px; padding:0 22px 4px; margin-top:-52px; position:relative; flex-wrap:wrap; }
  .af-ag-avwrap { box-sizing:border-box; width:112px; height:112px; border:4px solid #0f0f0f; border-radius:50%; background:#0f0f0f; flex-shrink:0; align-self:flex-start; display:flex; align-items:center; justify-content:center; overflow:hidden; box-shadow:0 6px 22px rgba(0,0,0,.5); }
  .af-ag-avwrap.ring { border-color:#ff5a00; box-shadow:0 0 0 2px rgba(255,90,0,.25), 0 6px 26px rgba(255,90,0,.3); }
  .af-ag-avwrap .af-av-img, .af-ag-avwrap .af-av-emoji { width:104px; height:104px; border-radius:50%; }
  .af-ag-id { flex:1; min-width:0; padding-top:58px; }
  .af-ag-namerow { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .af-ag-name { font-size:23px; font-weight:800; letter-spacing:-.5px; color:#fff; }
  .af-ag-tier { font-size:9px; font-weight:900; letter-spacing:.7px; color:#1a1a1a; border-radius:6px; padding:3px 9px; }
  .af-ag-submeta { display:flex; align-items:center; gap:12px; margin-top:8px; flex-wrap:wrap; }
  .af-ag-num { font-size:10px; font-weight:800; letter-spacing:.8px; color:#ff8a3d; background:rgba(255,90,0,.12); border:1px solid rgba(255,90,0,.32); border-radius:7px; padding:3px 9px; }
  .af-ag-handle { font-size:13px; font-weight:700; color:#9a9a9e; text-decoration:none; }
  .af-ag-handle:hover { color:#ff5a00; }
  .af-ag-reg { font-size:12px; color:#7c7c80; font-weight:500; margin-top:9px; }
  .af-ag-wallet { display:flex; align-items:center; gap:10px; margin-top:8px; font-size:12px; }
  .af-ag-wallet-lbl { font-size:9px; font-weight:800; letter-spacing:.7px; text-transform:uppercase; color:#777; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); border-radius:6px; padding:2px 7px; }
  .af-ag-wallet .mono { color:#cfcfcf; }
  .af-ag-desc { color:#b6b6ba; font-size:13.5px; line-height:1.55; padding:16px 22px 0; }
  .af-ag-stats { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; padding:18px 22px 4px; }
  @media(min-width:560px){ .af-ag-stats{ grid-template-columns:repeat(4,1fr); } }
  .af-ag-stat { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:15px; text-align:center; }
  .af-ag-stat-n { font-size:21px; font-weight:800; letter-spacing:-.4px; color:#fff; }
  .af-ag-stat-l { font-size:10px; color:#8a8a8a; font-weight:700; letter-spacing:.7px; text-transform:uppercase; margin-top:6px; }
  .af-ag-caps { display:flex; flex-wrap:wrap; gap:7px; padding:16px 22px 0; }
  .af-ag-cap { font-size:11px; font-weight:700; color:#cfcfcf; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:100px; padding:5px 12px; }
  .af-ag-card .af-section-label { padding:0 22px; }
  .af-ag-card .af-sib-list, .af-ag-card .af-nosib { padding:0 22px 22px; }
  .af-ag-tokens { display:grid; grid-template-columns:1fr; gap:8px; padding:0 22px 22px; }
  @media(min-width:560px){ .af-ag-tokens{ grid-template-columns:repeat(2,1fr); } }
  .af-ag-tok { display:flex; align-items:center; gap:11px; background:#181818; border:1px solid #242424; border-radius:13px; padding:11px 13px; cursor:pointer; transition:border-color .15s, background .15s; font-family:inherit; text-align:left; }
  .af-ag-tok:hover { border-color:#ff5a00; background:#1c1c1c; }
  .af-ag-tok .af-av-img, .af-ag-tok .af-av-emoji { flex-shrink:0; }
  .af-ag-tok-id { flex:1; min-width:0; }
  .af-ag-tok-name { font-size:13px; font-weight:700; color:#eee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-ag-tok-sym { font-size:11px; color:#ff5a00; font-weight:700; margin-top:2px; }
  .af-ag-tok-stats { text-align:right; flex-shrink:0; }
  .af-ag-tok-price { font-size:13px; font-weight:800; color:#fff; }
  .af-ag-tok-sub { font-size:10px; color:#8a8a8a; font-weight:600; margin-top:2px; }
  .af-row-chip.best { color:#ffb27a; }

  /* Platform source badges + breakdown */
  .af-plat { display:inline-flex; align-items:center; font-weight:800; letter-spacing:.4px; border:1px solid; border-radius:7px; white-space:nowrap; }
  .af-plat-sm { font-size:9px; padding:2px 7px; text-transform:uppercase; }
  .af-plat-lg { font-size:11px; padding:3px 10px; }
  .af-plat-breakdown { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:8px; font-size:12px; color:#9a9a9e; font-weight:600; padding:4px 6px 12px; }
  .af-plat-breakdown b { color:#fff; font-weight:800; }
  .af-plat-dot { color:#555; }
  .af-plat-filter { display:flex; align-items:center; justify-content:flex-start; flex-wrap:wrap; gap:8px; padding:0 12px 6px; }
  .af-plat-fbtn { font-size:12px; font-weight:700; letter-spacing:.2px; color:#b6b6ba; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:999px; padding:6px 14px; cursor:pointer; transition:background .15s,border-color .15s,color .15s; }
  .af-plat-fbtn:hover { background:rgba(255,255,255,.09); color:#fff; }
  .af-plat-fbtn.active { background:rgba(255,90,0,.16); border-color:rgba(255,90,0,.5); color:#ff8a3d; }
  .af-ag-platrow { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:#8a8a8a; font-weight:600; }

  .af-swap { margin-top:18px; background:#0f0f12; border:1px solid #242424; border-radius:16px; padding:14px; }
  .af-modal > .af-swap { margin-top:30px; } /* clear the close button when swap is at the top */
  .af-modal-hdr { margin-top:18px; }
  .af-swap-tabs { display:flex; gap:6px; background:#161616; border:1px solid #232323; border-radius:100px; padding:4px; margin-bottom:12px; }
  .af-swap-tab { flex:1; padding:9px 0; border:none; background:transparent; color:#888; border-radius:100px; font-size:13px; font-weight:700; cursor:pointer; transition:all .18s; font-family:inherit; }
  .af-swap-tab.buy.active { background:#22c55e; color:#04130a; box-shadow:0 2px 14px rgba(34,197,94,.35); }
  .af-swap-tab.sell.active { background:#ef4444; color:#fff; box-shadow:0 2px 14px rgba(239,68,68,.35); }
  .af-swap-field { background:#161616; border:1px solid #232323; border-radius:14px; padding:12px 14px; }
  .af-swap-field-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
  .af-swap-lbl { font-size:11px; color:#777; font-weight:600; }
  .af-swap-bal { font-size:12px; color:#bbb; font-weight:700; background:#202020; border:1px solid #2c2c2c; border-radius:100px; padding:3px 10px; }
  .af-swap-input { width:100%; background:transparent; border:none; outline:none; color:#fff; font-size:24px; font-weight:700; font-family:inherit; padding:0; }
  .af-swap-input::-webkit-outer-spin-button, .af-swap-input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
  .af-swap-output { font-size:24px; font-weight:700; color:#eaeaea; min-height:30px; overflow:hidden; text-overflow:ellipsis; }
  .af-swap-sub { font-size:11px; color:#666; margin-top:3px; min-height:14px; }
  .af-swap-arrow { text-align:center; color:#555; font-size:16px; margin:6px 0; }
  .af-swap-slip { display:flex; align-items:center; justify-content:space-between; margin-top:12px; }
  .af-slip-opts { display:flex; gap:6px; }
  .af-slip { background:#181818; border:1px solid #2a2a2a; color:#999; border-radius:9px; padding:5px 11px; font-size:12px; font-weight:700; cursor:pointer; transition:all .15s; font-family:inherit; }
  .af-slip.active { background:#ff5a00; border-color:#ff5a00; color:#fff; }
  .af-swap-rate { font-size:11px; color:#666; margin-top:12px; text-align:center; }
  .af-swap-btn { width:100%; margin-top:12px; padding:14px; border:none; border-radius:13px; font-size:15px; font-weight:800; cursor:pointer; transition:all .2s; font-family:inherit; color:#fff; }
  .af-swap-btn.buy { background:#22c55e; color:#04130a; } .af-swap-btn.sell { background:#ef4444; }
  .af-swap-btn.done { background:#1f8f4d !important; color:#fff !important; animation:swapPop .4s ease-out; }
  .af-swap-btn:disabled { background:#222; color:#555; cursor:not-allowed; }
  .af-swap-foot { font-size:10px; color:#555; text-align:center; margin-top:11px; }

  .af-toasts { position:fixed; bottom:20px; right:20px; z-index:60; display:flex; flex-direction:column; gap:8px; max-width:calc(100vw - 40px); }
  .af-toast { background:#16161c; border:1px solid rgba(168,85,247,.4); color:#e9d5ff; font-size:13px; font-weight:600; padding:12px 16px; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.5); animation:toastIn .3s cubic-bezier(.2,.8,.2,1); }

  @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:.4; } }
  @keyframes fade { from{ opacity:0; } to{ opacity:1; } }
  @keyframes rise { from{ opacity:0; transform:translateY(16px); } to{ opacity:1; transform:translateY(0); } }
  @keyframes toastIn { from{ opacity:0; transform:translateX(30px); } to{ opacity:1; transform:translateX(0); } }
  @keyframes swapPop { 0%{ transform:scale(1); } 40%{ transform:scale(1.04); } 100%{ transform:scale(1); } }
  @keyframes agbolt { 0%{ opacity:0; } 4%{ opacity:.9; } 9%{ opacity:0; } 100%{ opacity:0; } }
`;
