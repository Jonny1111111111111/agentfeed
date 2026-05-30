import { useState, useEffect, useRef, useMemo } from "react";
import snapshot from "./data/launches.json";
import agentsSnapshot from "./data/agents.json";
import {
  mapLaunch,
  getLatestBlock,
  fetchNewLaunches,
  resolveTokenMeta,
  fetchMarkets,
  computeFees,
  fmtUsd,
  short,
  dexUrl,
  basescanUrl,
  agentLabel,
  agentKey,
  avatarFor,
  daysSince,
  RUNTIME_LOOKBACK_BLOCKS,
} from "./lib/feed";

const DEX_POLL_MS = 30000;
const LAUNCH_POLL_MS = 60000;
const NEW_DAYS = 7;
const MAX_NEW_PER_CYCLE = 8; // cap additions per poll to survive spam bursts
const AGENTS = agentsSnapshot.agents || []; // static build-time snapshot

function makeToken(launch) {
  return { ...launch, market: null, fees: 0, isNew: false };
}

const fmtDate = (createdAt) => {
  const t = Date.parse((createdAt || "").replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// Avatar: real launcher image if available, else a deterministic emoji.
function Avatar({ token, size = 44 }) {
  const img = token.launcher?.image;
  if (img)
    return <img className="af-av-img" style={{ width: size, height: size }} src={img} alt="" loading="lazy" />;
  return (
    <span className="af-av-emoji" style={{ width: size, height: size, fontSize: size * 0.55 }}>
      {avatarFor(token.tokenAddress)}
    </span>
  );
}

// Generic avatar for an arbitrary image URL + seed (used for agents).
function PicAvatar({ src, seed, size = 44 }) {
  if (src) return <img className="af-av-img" style={{ width: size, height: size }} src={src} alt="" loading="lazy" />;
  return (
    <span className="af-av-emoji" style={{ width: size, height: size, fontSize: size * 0.55 }}>
      {avatarFor(seed || "agent")}
    </span>
  );
}

// Card for a registered 0xWork agent (Agents tab).
function AgentCard({ agent: a, onPickToken }) {
  const active = a.status === "Active";
  return (
    <div className="af-card af-agent-card">
      <div className="af-card-top">
        <PicAvatar src={a.image} seed={a.operatorAddress || a.name} size={44} />
        <div className="af-card-id">
          <div className="af-card-name">
            {a.name || "Unnamed agent"}
            {a.verified && <span className="af-verified" title="verified X handle">✓</span>}
          </div>
          <div className="af-card-tick">{a.handle || (a.operatorAddress ? short(a.operatorAddress) : "—")}</div>
        </div>
        <span className={`af-status ${active ? "on" : "off"}`}>{a.status}</span>
      </div>
      <div className="af-card-rows">
        <div className="af-card-row">
          <span className="af-k">Reputation</span>
          <span className="af-v">{a.reputation}{a.successRate != null ? ` · ${a.successRate}% success` : ""}</span>
        </div>
        <div className="af-card-row">
          <span className="af-k">Tasks done</span>
          <span className="af-v">{a.tasksCompleted}{a.totalEarned ? ` · $${a.totalEarned.toLocaleString("en-US")} earned` : ""}</span>
        </div>
        <div className="af-card-row tokens">
          <span className="af-k">Tokens</span>
          <span className="af-agent-tokens">
            {a.tokens.length === 0 ? (
              <span className="af-v">—</span>
            ) : (
              a.tokens.slice(0, 4).map((t) => (
                <button key={t.tokenAddress} className="af-token-chip" onClick={() => onPickToken(t.tokenAddress)}>
                  ${t.tokenSymbol}
                </button>
              ))
            )}
            {a.tokens.length > 4 && <span className="af-v">+{a.tokens.length - 4}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

// Feedr brand mark — minimal white "F" with a signal dot, on a dark tile.
function Logo({ size = 28, wordmark = true }) {
  return (
    <span className="af-logo">
      <svg className="af-logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#15151c" stroke="#26263010" />
        <path d="M10.5 7.5 H22 V11 H14.4 V14.6 H21 V18 H14.4 V24.5 H10.5 Z" fill="#fff" />
        <circle cx="23.4" cy="9" r="2.6" fill="#4f6ef7" />
      </svg>
      {wordmark && <span className="af-logo-word">Feedr</span>}
    </span>
  );
}

// X (Twitter) and Globe icons for card action buttons.
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

const xUrlFor = (handle) => (handle ? `https://x.com/${handle.replace(/^@/, "")}` : null);

// Bankr-style launch card: identity + LAUNCHER / FEE TO / CA / LAUNCHED + status + links.
function TokenCard({ token: t, isNew, onOpen }) {
  const [copied, setCopied] = useState(false);
  const who = agentLabel(t);
  const deployed = !!(t.poolId || t.market?.hasPool);
  const xUrl = xUrlFor(t.launcher?.handle);
  const webUrl = t.launchUrl || t.launcher?.profileUrl || null;
  const stop = (e) => e.stopPropagation();
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(t.tokenAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1300);
    }).catch(() => {});
  };

  return (
    <div className="af-card token" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}>
      <div className="af-tc-head">
        <Avatar token={t} size={46} />
        <div className="af-tc-id">
          <div className="af-tc-name">
            {t.tokenName}
            {isNew && <span className="af-new-badge">NEW</span>}
          </div>
          <div className="af-tc-tick">${t.tokenSymbol}{t.launcher?.verified && <span className="af-verified" title="verified">✓</span>}</div>
        </div>
        <span className={`af-badge ${deployed ? "deployed" : "pending"}`}>
          <span className="af-badge-dot" />{deployed ? "DEPLOYED" : "PENDING"}
        </span>
      </div>

      <div className="af-tc-rows">
        <div className="af-tc-row">
          <span className="af-k">Launcher</span>
          <span className="af-v">{who || "anonymous"}</span>
        </div>
        <div className="af-tc-row">
          <span className="af-k">Fee to</span>
          <span className="af-v mono">{t.feeRecipient ? short(t.feeRecipient) : "—"}</span>
        </div>
        <div className="af-tc-row">
          <span className="af-k">CA</span>
          <span className="af-ca">
            <span className="mono">{short(t.tokenAddress)}</span>
            <button className="af-ca-copy" onClick={copy} title="copy contract address">{copied ? "✓" : "⧉"}</button>
          </span>
        </div>
        <div className="af-tc-row">
          <span className="af-k">Launched</span>
          <span className="af-v">{fmtDate(t.createdAt)}</span>
        </div>
      </div>

      <div className="af-tc-actions">
        {xUrl && <a className="af-act" href={xUrl} target="_blank" rel="noreferrer" onClick={stop}><IconX /> X</a>}
        {webUrl && <a className="af-act" href={webUrl} target="_blank" rel="noreferrer" onClick={stop}><IconGlobe /> Website</a>}
        <a className="af-act ghost" href={dexUrl(t)} target="_blank" rel="noreferrer" onClick={stop}>Chart ↗</a>
      </div>
    </div>
  );
}

export default function AgentFeed() {
  const [tab, setTab] = useState("all");
  const [tokens, setTokens] = useState(() => (snapshot.items || []).map((l) => makeToken(mapLaunch(l))));
  const [loading, setLoading] = useState(true);
  const [rpcDown, setRpcDown] = useState(false);
  const [selected, setSelected] = useState(null); // tokenAddress of open detail
  const [toasts, setToasts] = useState([]); // transient new-launch notifications
  const [query, setQuery] = useState(""); // search box

  const agents = AGENTS;

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
        const markets = await fetchMarkets(tokensRef.current.map((t) => t.tokenAddress));
        if (!cancelled) applyMarkets(markets);
      } catch {
        /* retry on next poll */
      } finally {
        if (!cancelled) setLoading(false);
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
              launcher: { name: null, handle: null, image: null, verified: false },
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
        enriched.forEach((t) => pushToast(`🆕 ${t.tokenSymbol} just launched on-chain`));
      } catch {
        setRpcDown(true);
      }
    }, LAUNCH_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  // ── derived ──
  const isNew = (t) => t.isNew || daysSince(t.createdAt) < NEW_DAYS;
  const byDateDesc = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

  const activeCount = tokens.filter((t) => t.market?.hasPool).length;
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
    const base = tab === "new" ? tokens.filter(isNew) : [...tokens];
    return base.filter(matches).sort(byDateDesc);
  }, [tokens, tab, q]);

  // Agent search: name or handle.
  const agentList = useMemo(
    () => agents.filter((a) => !q || a.name?.toLowerCase().includes(q) || (a.handle || "").toLowerCase().includes(q)),
    [agents, q]
  );

  const selectedToken = selected && tokens.find((t) => t.tokenAddress.toLowerCase() === selected.toLowerCase());

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

  return (
    <div className="af-root">
      <style>{CSS}</style>

      <header className="af-header">
        <Logo size={28} />
        <div className="af-pill">
          <span className="af-live-dot" />
          <span className="af-live-txt">{loading ? "SYNC" : "LIVE"}</span>
        </div>
      </header>

      <div className="af-statbar">
        <div className="af-stat">
          <div className="af-stat-num">{tokens.length}</div>
          <div className="af-stat-lbl">Tokens Launched</div>
        </div>
        <div className="af-stat">
          <div className="af-stat-num">{activeCount}</div>
          <div className="af-stat-lbl">Active Pools</div>
        </div>
        <div className="af-stat">
          <div className="af-stat-num">{newCount}</div>
          <div className="af-stat-lbl">New This Week</div>
        </div>
        <div className="af-stat">
          <div className="af-stat-num">{fmtUsd(totalVol)}</div>
          <div className="af-stat-lbl">24h Volume</div>
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
        <button className={`af-tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>
          New This Week <span className="af-tab-count">{newCount}</span>
        </button>
      </div>

      <div className="af-search">
        <span className="af-search-icon">⌕</span>
        <input
          className="af-search-input"
          type="text"
          placeholder={tab === "agents" ? "Search agents by name or handle…" : "Search by token name, ticker, or agent…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <button className="af-search-clear" onClick={() => setQuery("")} aria-label="clear">✕</button>}
      </div>

      {tab === "agents" ? (
        <div className="af-grid">
          {agentList.length === 0 && <div className="af-empty">No agents match “{query}”.</div>}
          {agentList.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onPickToken={(addr) => {
                const known = tokensRef.current.find((t) => t.tokenAddress.toLowerCase() === addr.toLowerCase());
                if (known) setSelected(known.tokenAddress);
                else window.open(`https://dexscreener.com/base/${addr}`, "_blank", "noopener");
              }}
            />
          ))}
        </div>
      ) : (
        <div className="af-grid">
          {list.length === 0 && <div className="af-empty">No tokens match “{query}”.</div>}
          {list.map((t) => (
            <TokenCard key={t.tokenAddress} token={t} isNew={isNew(t)} onOpen={() => setSelected(t.tokenAddress)} />
          ))}
        </div>
      )}

      <footer className="af-footer">
        <div className="af-foot-main">
          <div className="af-foot-brand">
            <Logo size={30} />
            <p className="af-foot-tag">The live token feed for onchain AI agents.</p>
            <p className="af-foot-powered">
              Powered by
              <a href="https://base.org" target="_blank" rel="noreferrer">Base</a>·
              <a href="https://uniswap.org" target="_blank" rel="noreferrer">Uniswap v4</a>·
              <a href="https://dexscreener.com" target="_blank" rel="noreferrer">DEXScreener</a>
            </p>
          </div>
          <nav className="af-foot-links">
            <a href="https://docs.base.org" target="_blank" rel="noreferrer">Docs</a>
            <a href="https://discord.com" target="_blank" rel="noreferrer">Discord</a>
            <a href="https://x.com" target="_blank" rel="noreferrer">X (Twitter)</a>
            <a href="https://github.com/Jonny1111111111111/agentfeed" target="_blank" rel="noreferrer">GitHub</a>
          </nav>
        </div>
        <div className="af-foot-bottom">
          <span>© 2026 Feedr</span>
          <span className="af-foot-fine">{tokens.length} tokens with live pools · indexed on-chain · not affiliated with 0xWork</span>
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
    </div>
  );
}

/* ─────────────────── Detail modal ─────────────────── */
function TokenDetail({ token: t, siblings, onClose, onPick, isNew, pushToast }) {
  const [copied, setCopied] = useState(false);
  const m = t.market;
  const who = agentLabel(t);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.tokenAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="af-modal-bg" onClick={onClose}>
      <div className="af-modal" onClick={(e) => e.stopPropagation()}>
        <button className="af-modal-x" onClick={onClose} aria-label="close">✕</button>

        <div className="af-modal-hdr">
          <Avatar token={t} size={64} />
          <div>
            <div className="af-modal-name">
              {t.tokenName}
              {isNew(t) && <span className="af-new-badge">NEW</span>}
            </div>
            <div className="af-modal-sub">
              ${t.tokenSymbol}
              {t.launcher?.verified && <span className="af-verified">✓ verified</span>}
            </div>
            <div className="af-modal-agent">{who ? `by ${who}` : "anonymous launcher"}</div>
          </div>
        </div>

        <div className="af-modal-meta">
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
        </div>

        {m?.hasPool ? (
          <>
            <div className="af-section-label">Market · DEXScreener</div>
            <div className="af-market-grid">
              <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(m.priceUsd)}</div><div className="af-mkt-l">Price</div></div>
              <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(m.volume24h)}</div><div className="af-mkt-l">24h Volume</div></div>
              <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(m.liquidityUsd)}</div><div className="af-mkt-l">Liquidity</div></div>
              <div className="af-mkt"><div className="af-mkt-n">{fmtUsd(t.fees)}</div><div className="af-mkt-l">Fees (24h est.)</div></div>
            </div>
            <div className={`af-chg ${m.priceChange24h >= 0 ? "pos" : "neg"}`}>
              {m.priceChange24h >= 0 ? "▲" : "▼"} {Math.abs(m.priceChange24h).toFixed(1)}% (24h)
            </div>
            <a className="af-dex-btn" href={dexUrl(t)} target="_blank" rel="noreferrer">Open on DEXScreener ↗</a>

            <SwapBox token={t} pushToast={pushToast} />
          </>
        ) : (
          <div className="af-nopool">No active pool yet — this token hasn’t started trading on a DEX.</div>
        )}

        <div className="af-section-label">
          Other tokens by this agent {siblings.length > 0 && <span className="af-tab-count">{siblings.length}</span>}
        </div>
        {siblings.length === 0 ? (
          <div className="af-nosib">No other launches found for this agent.</div>
        ) : (
          <div className="af-sib-list">
            {siblings.slice(0, 12).map((s) => (
              <button key={s.tokenAddress} className="af-sib" onClick={() => onPick(s.tokenAddress)}>
                <Avatar token={s} size={28} />
                <span className="af-sib-name">{s.tokenName}</span>
                <span className="af-sib-tick">${s.tokenSymbol}</span>
                {s.market?.hasPool && <span className="af-card-livedot" />}
              </button>
            ))}
            {siblings.length > 12 && <div className="af-sib-more">+{siblings.length - 12} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────── Swap demo (no real execution) ─────────────────── */
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
      pushToast?.(`✅ Swapped ${fmtAmt(amt)} ${inSym} → ${fmtAmt(rawOut)} ${outSym} (demo)`);
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

      <div className="af-swap-foot">⚡ Powered by Uniswap v4 · demo only — no wallet, no execution</div>
    </div>
  );
}

/* ─────────────────────── CSS ─────────────────────── */
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a; }
  ::-webkit-scrollbar { width: 6px; height:6px; background: #111; }
  ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }

  .af-root { background:#0a0a0a; min-height:100vh; font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#fff; }

  .af-header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid #1a1a1a; position:sticky; top:0; background:rgba(10,10,10,0.92); backdrop-filter:blur(12px); z-index:20; }
  .af-logo { display:inline-flex; align-items:center; gap:9px; }
  .af-logo-mark { border-radius:8px; box-shadow:0 0 0 1px #26262e, 0 2px 10px rgba(79,110,247,.2); flex-shrink:0; }
  .af-logo-word { font-size:19px; font-weight:800; letter-spacing:-0.6px; color:#fff; }
  .af-pill { display:flex; align-items:center; gap:6px; background:#161616; border:1px solid #262626; border-radius:100px; padding:7px 14px; }
  .af-live-dot { width:7px; height:7px; border-radius:50%; background:#22c55e; box-shadow:0 0 6px #22c55e; animation:pulse 1.8s ease-in-out infinite; flex-shrink:0; }
  .af-live-txt { font-size:10px; font-weight:800; color:#22c55e; letter-spacing:1.2px; }

  .af-statbar { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; padding:18px 16px 0; max-width:1240px; margin:0 auto; }
  @media(min-width:680px){ .af-statbar{ grid-template-columns:repeat(4,1fr); padding:22px 28px 0; } }
  .af-stat { background:#141414; border:1px solid #232323; border-radius:16px; padding:16px 18px; }
  .af-stat-num { font-size:24px; font-weight:800; letter-spacing:-.5px; }
  .af-stat-lbl { font-size:10px; color:#888; font-weight:600; letter-spacing:.9px; text-transform:uppercase; margin-top:5px; }

  .af-note { margin:14px 16px 0; padding:9px 14px; background:rgba(168,85,247,.1); border:1px solid rgba(168,85,247,.3); border-radius:12px; color:#c084fc; font-size:11px; max-width:1240px; }
  @media(min-width:680px){ .af-note{ margin:14px 28px 0; } }

  .af-tabs { display:flex; gap:8px; padding:18px 16px 4px; max-width:1240px; margin:0 auto; flex-wrap:wrap; }
  @media(min-width:680px){ .af-tabs{ padding:22px 28px 4px; } }
  .af-tab { padding:9px 16px; border:1px solid #232323; background:#141414; color:#888; border-radius:100px; font-size:13px; font-weight:600; cursor:pointer; transition:all .18s; display:flex; align-items:center; gap:7px; font-family:inherit; }
  .af-tab:hover { border-color:#3a3a3a; color:#bbb; }
  .af-tab.active { background:#4f6ef7; border-color:#4f6ef7; color:#fff; box-shadow:0 2px 18px rgba(79,110,247,.35); }
  .af-tab-count { font-size:11px; font-weight:800; background:rgba(255,255,255,.14); border-radius:100px; padding:1px 8px; }
  .af-tab.active .af-tab-count { background:rgba(255,255,255,.22); }

  .af-grid { display:grid; grid-template-columns:1fr; gap:12px; padding:16px; max-width:1240px; margin:0 auto; }
  @media(min-width:560px){ .af-grid{ grid-template-columns:repeat(2,1fr); } }
  @media(min-width:900px){ .af-grid{ grid-template-columns:repeat(3,1fr); padding:16px 28px 28px; } }
  .af-empty { color:#666; font-size:13px; padding:40px; text-align:center; grid-column:1/-1; }

  .af-card { background:#141414; border:1px solid #232323; border-radius:18px; padding:16px; text-align:left; cursor:pointer; transition:border-color .2s, transform .12s, background .2s; font-family:inherit; color:inherit; display:flex; flex-direction:column; gap:14px; }
  .af-card:hover { border-color:#4f6ef7; background:#171717; transform:translateY(-2px); }
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
  .af-new-badge { font-size:8px; font-weight:800; letter-spacing:1px; background:rgba(168,85,247,.16); color:#c084fc; border:1px solid rgba(168,85,247,.35); border-radius:6px; padding:1px 6px; flex-shrink:0; }
  .af-verified { font-size:11px; font-weight:800; color:#22c55e; }

  .af-av-img { border-radius:50%; object-fit:cover; flex-shrink:0; background:#222; }
  .af-av-emoji { display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background:#1d1d1d; border:1px solid #2a2a2a; flex-shrink:0; line-height:1; }

  /* Token launch card (Bankr-style) */
  .af-card.token { gap:0; padding:0; overflow:hidden; }
  .af-card.token:focus-visible { outline:2px solid #4f6ef7; outline-offset:2px; }
  .af-tc-head { display:flex; align-items:center; gap:12px; padding:16px 16px 12px; }
  .af-tc-id { flex:1; min-width:0; }
  .af-tc-name { font-size:15px; font-weight:700; display:flex; align-items:center; gap:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-tc-tick { font-size:12px; color:#7a7a7a; font-weight:700; margin-top:2px; display:flex; align-items:center; gap:5px; }
  .af-badge { display:inline-flex; align-items:center; gap:5px; font-size:9px; font-weight:800; letter-spacing:.8px; border-radius:100px; padding:4px 9px; flex-shrink:0; }
  .af-badge-dot { width:5px; height:5px; border-radius:50%; }
  .af-badge.deployed { background:rgba(34,197,94,.12); color:#22c55e; border:1px solid rgba(34,197,94,.28); }
  .af-badge.deployed .af-badge-dot { background:#22c55e; box-shadow:0 0 6px #22c55e; }
  .af-badge.pending { background:rgba(234,179,8,.12); color:#eab308; border:1px solid rgba(234,179,8,.28); }
  .af-badge.pending .af-badge-dot { background:#eab308; }
  .af-tc-rows { display:flex; flex-direction:column; gap:8px; padding:12px 16px; border-top:1px solid #1d1d1d; border-bottom:1px solid #1d1d1d; background:#121212; }
  .af-tc-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .af-ca { display:flex; align-items:center; gap:7px; }
  .af-ca-copy { background:#1c1c1c; border:1px solid #2a2a2a; color:#999; border-radius:6px; width:22px; height:22px; font-size:11px; cursor:pointer; line-height:1; }
  .af-ca-copy:hover { color:#fff; border-color:#4f6ef7; }
  .af-tc-actions { display:flex; gap:8px; padding:12px 16px 14px; }
  .af-act { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:#cfcfcf; background:#1a1a1a; border:1px solid #2a2a2a; border-radius:10px; padding:7px 12px; text-decoration:none; transition:all .15s; }
  .af-act:hover { border-color:#4f6ef7; color:#fff; background:#1e1e1e; }
  .af-act.ghost { margin-left:auto; color:#888; }

  /* Footer */
  .af-footer { border-top:1px solid #161616; padding:32px 20px 26px; max-width:1240px; margin:36px auto 0; }
  .af-foot-main { display:flex; flex-direction:column; gap:24px; justify-content:space-between; }
  @media(min-width:680px){ .af-foot-main{ flex-direction:row; align-items:flex-start; padding:0 8px; } }
  .af-foot-brand { max-width:340px; }
  .af-foot-tag { font-size:13px; color:#999; margin-top:12px; line-height:1.5; }
  .af-foot-powered { font-size:11px; color:#555; margin-top:14px; display:flex; flex-wrap:wrap; gap:7px; align-items:center; }
  .af-foot-powered a { color:#888; text-decoration:none; font-weight:600; }
  .af-foot-powered a:hover { color:#4f6ef7; }
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
  .af-modal-agent { font-size:12px; color:#4f6ef7; font-weight:600; margin-top:4px; }

  .af-modal-meta { margin-top:18px; display:flex; flex-direction:column; gap:11px; border-top:1px solid #1e1e1e; padding-top:16px; }
  .af-meta-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .af-addr { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .af-copy { font-size:11px; font-weight:700; background:#1c1c1c; border:1px solid #2a2a2a; color:#bbb; border-radius:8px; padding:3px 9px; cursor:pointer; transition:all .15s; font-family:inherit; }
  .af-copy:hover { border-color:#4f6ef7; color:#fff; }
  .af-link { font-size:11px; font-weight:700; color:#4f6ef7; text-decoration:none; }
  .af-link:hover { text-decoration:underline; }

  .af-section-label { font-size:10px; color:#777; font-weight:700; letter-spacing:1px; text-transform:uppercase; margin:20px 0 11px; display:flex; align-items:center; gap:8px; }
  .af-market-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
  .af-mkt { background:#181818; border:1px solid #242424; border-radius:14px; padding:14px; }
  .af-mkt-n { font-size:18px; font-weight:800; letter-spacing:-.4px; }
  .af-mkt-l { font-size:10px; color:#777; font-weight:600; letter-spacing:.6px; text-transform:uppercase; margin-top:5px; }
  .af-chg { font-size:13px; font-weight:700; margin-top:12px; }
  .af-chg.pos { color:#22c55e; } .af-chg.neg { color:#ef4444; }
  .af-dex-btn { display:block; text-align:center; margin-top:14px; background:#4f6ef7; color:#fff; font-size:13px; font-weight:700; padding:12px; border-radius:12px; text-decoration:none; transition:background .15s; }
  .af-dex-btn:hover { background:#3d5bea; }
  .af-nopool { background:#181818; border:1px dashed #2e2e2e; border-radius:14px; padding:18px; color:#888; font-size:13px; text-align:center; margin-top:6px; }

  .af-sib-list { display:flex; flex-direction:column; gap:7px; }
  .af-sib { display:flex; align-items:center; gap:10px; background:#181818; border:1px solid #242424; border-radius:12px; padding:9px 12px; cursor:pointer; transition:border-color .15s, background .15s; font-family:inherit; text-align:left; }
  .af-sib:hover { border-color:#4f6ef7; background:#1c1c1c; }
  .af-sib-name { flex:1; font-size:13px; font-weight:700; color:#eee; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-sib-tick { font-size:11px; color:#777; font-weight:700; }
  .af-sib-more { font-size:11px; color:#666; padding:6px 4px; text-align:center; }
  .af-nosib { font-size:12px; color:#666; padding:6px 2px; }

  .af-search { display:flex; align-items:center; gap:10px; max-width:1240px; margin:6px auto 0; padding:0 16px; }
  @media(min-width:680px){ .af-search{ padding:0 28px; } }
  .af-search-icon { color:#666; font-size:18px; flex-shrink:0; }
  .af-search-input { flex:1; background:#141414; border:1px solid #242424; border-radius:12px; padding:11px 14px; color:#fff; font-size:14px; font-family:inherit; outline:none; transition:border-color .15s; }
  .af-search-input::placeholder { color:#5a5a5a; }
  .af-search-input:focus { border-color:#4f6ef7; }
  .af-search-clear { background:#1c1c1c; border:1px solid #2a2a2a; color:#999; border-radius:9px; width:32px; height:32px; cursor:pointer; font-size:12px; flex-shrink:0; }
  .af-search-clear:hover { color:#fff; border-color:#3a3a3a; }

  .af-status { font-size:10px; font-weight:800; letter-spacing:.5px; border-radius:100px; padding:3px 9px; flex-shrink:0; text-transform:uppercase; }
  .af-status.on { background:rgba(34,197,94,.14); color:#22c55e; border:1px solid rgba(34,197,94,.3); }
  .af-status.off { background:#202020; color:#888; border:1px solid #2c2c2c; }
  .af-card.af-agent-card { cursor:default; }
  .af-card.af-agent-card:hover { transform:none; border-color:#2f2f2f; }
  .af-card-row.tokens { align-items:flex-start; }
  .af-agent-tokens { display:flex; flex-wrap:wrap; gap:5px; justify-content:flex-end; max-width:70%; }
  .af-token-chip { background:#1b2030; border:1px solid #2c3550; color:#9bb0ff; border-radius:8px; padding:3px 8px; font-size:11px; font-weight:700; cursor:pointer; font-family:inherit; transition:all .15s; }
  .af-token-chip:hover { border-color:#4f6ef7; color:#fff; background:#222a40; }

  .af-swap { margin-top:18px; background:#0f0f12; border:1px solid #242424; border-radius:16px; padding:14px; }
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
  .af-slip.active { background:#4f6ef7; border-color:#4f6ef7; color:#fff; }
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
`;
