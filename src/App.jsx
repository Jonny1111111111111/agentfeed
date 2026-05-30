import { useState, useEffect, useRef, useMemo } from "react";
import snapshot from "./data/launches.json";
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
  SWAP_FEE_RATE,
  FEE_AGENT_SHARE,
} from "./lib/feed";

const DEX_POLL_MS = 30000;
const LAUNCH_POLL_MS = 60000;
const NEW_DAYS = 7;
const MAX_NEW_PER_CYCLE = 8; // cap additions per poll to survive spam bursts

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

export default function AgentFeed() {
  const [tab, setTab] = useState("all");
  const [tokens, setTokens] = useState(() => (snapshot.items || []).map((l) => makeToken(mapLaunch(l))));
  const [loading, setLoading] = useState(true);
  const [rpcDown, setRpcDown] = useState(false);
  const [selected, setSelected] = useState(null); // tokenAddress of open detail
  const [toasts, setToasts] = useState([]); // transient new-launch notifications

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

  const list = useMemo(() => {
    if (tab === "active")
      return tokens.filter((t) => t.market?.hasPool).sort((a, b) => (b.market.volume24h || 0) - (a.market.volume24h || 0));
    if (tab === "new") return tokens.filter(isNew).sort(byDateDesc);
    return [...tokens].sort(byDateDesc);
  }, [tokens, tab]);

  const selectedToken = selected && tokens.find((t) => t.tokenAddress === selected);

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
        <div className="af-logo">
          <span className="af-logo-dot" />
          <span className="af-logo-text">0xWork</span>
          <span className="af-logo-badge">FEED</span>
        </div>
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
        <button className={`af-tab ${tab === "active" ? "active" : ""}`} onClick={() => setTab("active")}>
          Active <span className="af-tab-count">{activeCount}</span>
        </button>
        <button className={`af-tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>
          New This Week <span className="af-tab-count">{newCount}</span>
        </button>
      </div>

      <div className="af-grid">
        {list.length === 0 && <div className="af-empty">No tokens in this view.</div>}
        {list.map((t) => {
          const who = agentLabel(t);
          return (
            <button key={t.tokenAddress} className="af-card" onClick={() => setSelected(t.tokenAddress)}>
              <div className="af-card-top">
                <Avatar token={t} size={44} />
                <div className="af-card-id">
                  <div className="af-card-name">
                    {t.tokenName}
                    {isNew(t) && <span className="af-new-badge">NEW</span>}
                  </div>
                  <div className="af-card-tick">
                    ${t.tokenSymbol}
                    {t.launcher?.verified && <span className="af-verified" title="verified launcher">✓</span>}
                  </div>
                </div>
                {t.market?.hasPool && <span className="af-card-livedot" title="active pool" />}
              </div>
              <div className="af-card-rows">
                <div className="af-card-row">
                  <span className="af-k">Agent</span>
                  <span className="af-v">{who || "anonymous"}</span>
                </div>
                <div className="af-card-row">
                  <span className="af-k">Launched</span>
                  <span className="af-v">{fmtDate(t.createdAt)}</span>
                </div>
                <div className="af-card-row">
                  <span className="af-k">Token</span>
                  <span className="af-v mono">{short(t.tokenAddress)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <footer className="af-footer">
        {tokens.length} agent tokens with live pools · launches indexed on-chain from the Base v4 hook
        <span className="mono"> {short("0xbb7784a4d481184283ed89619a3e3ed143e1adc0")}</span> · trading data: DEXScreener · fees ≈ vol × {FEE_AGENT_SHARE} × {SWAP_FEE_RATE} · not affiliated with 0xWork
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
        />
      )}
    </div>
  );
}

/* ─────────────────── Detail modal ─────────────────── */
function TokenDetail({ token: t, siblings, onClose, onPick, isNew }) {
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

/* ─────────────────────── CSS ─────────────────────── */
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a; }
  ::-webkit-scrollbar { width: 6px; height:6px; background: #111; }
  ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }

  .af-root { background:#0a0a0a; min-height:100vh; font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#fff; }

  .af-header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid #1a1a1a; position:sticky; top:0; background:rgba(10,10,10,0.92); backdrop-filter:blur(12px); z-index:20; }
  .af-logo { display:flex; align-items:center; gap:8px; }
  .af-logo-dot { width:10px; height:10px; border-radius:50%; background:#4f6ef7; box-shadow:0 0 10px #4f6ef7; }
  .af-logo-text { font-size:18px; font-weight:800; letter-spacing:-0.5px; }
  .af-logo-badge { font-size:9px; font-weight:800; letter-spacing:1.8px; color:#4f6ef7; background:rgba(79,110,247,.12); padding:2px 8px; border-radius:6px; border:1px solid rgba(79,110,247,.25); }
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

  .af-footer { text-align:center; font-size:10px; color:#444; padding:24px 18px; border-top:1px solid #161616; line-height:1.6; }

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

  .af-toasts { position:fixed; bottom:20px; right:20px; z-index:60; display:flex; flex-direction:column; gap:8px; max-width:calc(100vw - 40px); }
  .af-toast { background:#16161c; border:1px solid rgba(168,85,247,.4); color:#e9d5ff; font-size:13px; font-weight:600; padding:12px 16px; border-radius:12px; box-shadow:0 8px 30px rgba(0,0,0,.5); animation:toastIn .3s cubic-bezier(.2,.8,.2,1); }

  @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:.4; } }
  @keyframes fade { from{ opacity:0; } to{ opacity:1; } }
  @keyframes rise { from{ opacity:0; transform:translateY(16px); } to{ opacity:1; transform:translateY(0); } }
  @keyframes toastIn { from{ opacity:0; transform:translateX(30px); } to{ opacity:1; transform:translateX(0); } }
`;
