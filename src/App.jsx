import { useState, useEffect, useRef } from "react";
import snapshot from "./data/launches.json";
import {
  mapLaunch,
  fetchLaunchesLive,
  fetchMarkets,
  computeFees,
  fmtUsd,
  fmtNum,
  short,
  dexUrl,
  avatarFor,
  daysSince,
  nowTime,
  SWAP_FEE_RATE,
  FEE_AGENT_SHARE,
} from "./lib/feed";

const DEX_POLL_MS = 30000;
const LAUNCH_POLL_MS = 60000;
const NEW_DAYS = 7;
const MAX_FEED = 30;

function makeToken(launch) {
  return { ...launch, market: null, fees: 0, isNew: false };
}

let evtSeq = 0;
const mkEvent = (e) => ({ id: `${Date.now()}-${evtSeq++}`, time: nowTime(), ...e });

export default function AgentFeed() {
  const [tab, setTab] = useState("leaderboard");
  const [tokens, setTokens] = useState(() => (snapshot.items || []).map((l) => makeToken(mapLaunch(l))));
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [proxyDown, setProxyDown] = useState(false);
  const [tickerOff, setTickerOff] = useState(0);
  const [flashIds, setFlashIds] = useState(new Set());

  const prevVol = useRef({}); // lowerAddr -> last seen 24h volume
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  function applyMarkets(markets, { emitFees }) {
    const events = [];
    setTokens((prev) =>
      prev.map((t) => {
        const m = markets[t.tokenAddress.toLowerCase()];
        if (!m) return t;
        const fees = computeFees(m.volume24h);
        const last = prevVol.current[t.tokenAddress.toLowerCase()];
        if (emitFees && last != null && m.volume24h > last + 0.01) {
          const deltaFee = computeFees(m.volume24h - last);
          events.push(
            mkEvent({
              type: "fee",
              color: "#4f6ef7",
              icon: "💰",
              text: `${t.tokenSymbol} earned ${fmtUsd(deltaFee)} in fees`,
              addr: t.tokenAddress,
              flash: t.tokenAddress,
            })
          );
        }
        prevVol.current[t.tokenAddress.toLowerCase()] = m.volume24h;
        return { ...t, market: m, fees };
      })
    );
    if (events.length) pushEvents(events);
  }

  function pushEvents(events) {
    setFeed((prev) => [...events, ...prev].slice(0, MAX_FEED));
    const flashes = events.map((e) => e.flash).filter(Boolean);
    if (flashes.length) {
      setFlashIds(new Set(flashes));
      setTimeout(() => setFlashIds(new Set()), 1000);
    }
  }

  // Initial market load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const addrs = tokensRef.current.map((t) => t.tokenAddress);
        const markets = await fetchMarkets(addrs);
        if (!cancelled) applyMarkets(markets, { emitFees: false });
      } catch {
        /* DEXScreener hiccup; next poll retries */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll DEXScreener for live trading data + fee events.
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const addrs = tokensRef.current.map((t) => t.tokenAddress);
        const markets = await fetchMarkets(addrs);
        applyMarkets(markets, { emitFees: true });
      } catch {
        /* transient */
      }
    }, DEX_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  // Poll 0xWork launches (via proxy) for newly launched verified agents.
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const live = await fetchLaunchesLive();
        setProxyDown(false);
        const known = new Set(tokensRef.current.map((t) => t.tokenAddress.toLowerCase()));
        const fresh = live.filter((l) => !known.has(l.tokenAddress.toLowerCase()));
        if (fresh.length) {
          setTokens((prev) => [...fresh.map((l) => ({ ...makeToken(l), isNew: true })), ...prev]);
          pushEvents(
            fresh.map((l) =>
              mkEvent({
                type: "launch",
                color: "#a855f7",
                icon: "🆕",
                text: `${l.tokenSymbol} launched${l.agentName ? ` by ${l.agentName}` : ""}`,
                addr: l.tokenAddress,
                flash: l.tokenAddress,
              })
            )
          );
        }
      } catch {
        setProxyDown(true); // proxy unavailable — snapshot list stays in place
      }
    }, LAUNCH_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  // Ticker animation.
  useEffect(() => {
    const iv = setInterval(() => setTickerOff((p) => p - 1), 22);
    return () => clearInterval(iv);
  }, []);

  // Derived views.
  const isNew = (t) => t.isNew || daysSince(t.createdAt) < NEW_DAYS;
  const leaderboard = [...tokens].sort((a, b) => b.fees - a.fees);
  const newAgents = [...tokens].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const newCount = tokens.filter(isNew).length;
  const totalVol = tokens.reduce((s, t) => s + (t.market?.volume24h || 0), 0);
  const totalFees = tokens.reduce((s, t) => s + t.fees, 0);
  const topToken = leaderboard[0];
  const displayed = tab === "leaderboard" ? leaderboard : newAgents;

  const tickerItems = [];
  leaderboard.forEach((t) => {
    if (t.market?.hasPool) tickerItems.push(`${t.tokenSymbol} ${t.market.priceChange24h >= 0 ? "+" : ""}${t.market.priceChange24h.toFixed(1)}%`);
  });
  if (totalFees > 0) tickerItems.push(`Fees ${fmtUsd(totalFees)}`);
  tickerItems.push(`Vol ${fmtUsd(totalVol)}`);
  const tickerFull = tickerItems.length ? [...tickerItems, ...tickerItems, ...tickerItems] : ["loading 0xWork launches…"];

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
          <span className="af-pill-icon">✅</span>
          <span className="af-pill-val">{tokens.length}</span>
          <span className="af-pill-lbl">verified</span>
          <span className="af-pill-div" />
          <span className="af-live-dot" />
          <span className="af-live-txt">{loading ? "SYNC" : "LIVE"}</span>
        </div>
      </header>

      <div className="af-ticker-wrap">
        <div className="af-ticker-track" style={{ transform: `translateX(${tickerOff % (tickerFull.length * 120)}px)` }}>
          {tickerFull.map((item, i) => (
            <span key={i} className={`af-ticker-item ${item.includes("-") ? "red" : item.includes("+") ? "green" : "muted"}`}>
              {item}
              <span className="af-tick-sep">·</span>
            </span>
          ))}
        </div>
      </div>

      {proxyDown && (
        <div className="af-note">ℹ️ Live launch polling unavailable (CORS proxy down) — showing the verified snapshot. Trading data is still live.</div>
      )}

      <div className="af-body">
        <div className="af-main">
          <div className="af-stat-row">
            <div className="af-stat-card">
              <div className="af-stat-icon">{topToken ? avatarFor(topToken.tokenAddress) : "🏆"}</div>
              <div className="af-stat-num">{topToken ? fmtUsd(topToken.fees) : "—"}</div>
              <div className="af-stat-lbl">Top Fee Agent</div>
              <div className="af-stat-sub">{topToken?.tokenSymbol || "—"}</div>
            </div>
            <div className="af-stat-card">
              <div className="af-stat-icon">🆕</div>
              <div className="af-stat-num">{newCount}</div>
              <div className="af-stat-lbl">New Agents</div>
              <div className="af-stat-sub">last {NEW_DAYS}d</div>
            </div>
            <div className="af-stat-card">
              <div className="af-stat-icon">📊</div>
              <div className="af-stat-num">{fmtUsd(totalVol)}</div>
              <div className="af-stat-lbl">Total Volume</div>
              <div className="af-stat-sub">24h · DEXScreener</div>
            </div>
          </div>

          <div className="af-tabs">
            <button className={`af-tab ${tab === "leaderboard" ? "active" : ""}`} onClick={() => setTab("leaderboard")}>
              Fee Leaderboard
            </button>
            <button className={`af-tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>
              New Agents
              {newCount > 0 && <span className="af-tab-badge">{newCount}</span>}
            </button>
          </div>

          <div className="af-agent-list">
            {displayed.map((t, i) => {
              const m = t.market;
              const chg = m?.priceChange24h ?? 0;
              return (
                <a key={t.tokenAddress} href={dexUrl(t)} target="_blank" rel="noreferrer" className={`af-agent-card${flashIds.has(t.tokenAddress) ? " flash" : ""}`}>
                  <span className="af-rank">#{i + 1}</span>
                  <span className="af-avatar">{avatarFor(t.tokenAddress)}</span>
                  <div className="af-agent-info">
                    <div className="af-agent-name">
                      {t.tokenName}
                      {isNew(t) && <span className="af-new-badge">NEW</span>}
                    </div>
                    <div className="af-agent-sym">${t.tokenSymbol}{t.agentName ? ` · ${t.agentName}` : ""}</div>
                  </div>
                  <div className="af-agent-meta">
                    <div className="af-agent-fee">{m?.hasPool ? fmtUsd(t.fees) : "—"}</div>
                    {m?.hasPool ? (
                      <div className={`af-agent-chg ${chg >= 0 ? "pos" : "neg"}`}>{chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(1)}%</div>
                    ) : (
                      <div className="af-agent-chg muted">no pool</div>
                    )}
                  </div>
                  <div className="af-agent-right">
                    <div className="af-holders">{m?.hasPool ? fmtUsd(m.liquidityUsd) : "—"}</div>
                    <div className="af-holders-lbl">liquidity</div>
                  </div>
                </a>
              );
            })}
          </div>
        </div>

        <div className="af-sidebar">
          <div className="af-section-hdr">
            <span className="af-section-title">Live Activity</span>
            <span className="af-live-dot" />
            <span className="af-live-txt">{loading ? "SYNC" : "LIVE"}</span>
          </div>
          <div className="af-feed-list">
            {feed.length === 0 && (
              <div className="af-feed-empty">{loading ? "Loading trading data…" : "Watching for volume changes & new launches…"}</div>
            )}
            {feed.map((ev, i) => (
              <div key={ev.id} className={`af-feed-card${i === 0 ? " feed-new" : ""}`} style={{ opacity: Math.max(0.4, 1 - i * 0.05) }}>
                <span className="af-feed-dot" style={{ background: ev.color }} />
                <span className="af-feed-icon">{ev.icon}</span>
                <span className="af-feed-text">{ev.text}</span>
                <span className="af-feed-time">{ev.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="af-footer">
        Verified launches: 0xWork token-forge · trading data: DEXScreener · fees ≈ vol × {FEE_AGENT_SHARE} × {SWAP_FEE_RATE} · not affiliated with 0xWork
      </footer>
    </div>
  );
}

/* ─────────────────────── CSS ─────────────────────── */
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0d0d0d; }
  ::-webkit-scrollbar { width: 4px; background: #111; }
  ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }

  .af-root { background:#0d0d0d; min-height:100vh; font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#fff; }

  .af-header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid #1e1e1e; position:sticky; top:0; background:rgba(13,13,13,0.95); backdrop-filter:blur(12px); z-index:20; }
  .af-logo { display:flex; align-items:center; gap:8px; }
  .af-logo-dot { width:10px; height:10px; border-radius:50%; background:#4f6ef7; box-shadow:0 0 10px #4f6ef7; }
  .af-logo-text { font-size:18px; font-weight:800; letter-spacing:-0.5px; }
  .af-logo-badge { font-size:9px; font-weight:800; letter-spacing:1.8px; color:#4f6ef7; background:rgba(79,110,247,.12); padding:2px 8px; border-radius:6px; border:1px solid rgba(79,110,247,.25); }
  .af-pill { display:flex; align-items:center; gap:5px; background:#1a1a1a; border:1px solid #2a2a2a; border-radius:100px; padding:7px 14px; }
  .af-pill-icon { font-size:13px; }
  .af-pill-val { font-size:14px; font-weight:700; }
  .af-pill-lbl { font-size:11px; color:#888; }
  .af-pill-div { width:1px; height:12px; background:#2a2a2a; margin:0 4px; }
  .af-live-dot { width:6px; height:6px; border-radius:50%; background:#22c55e; box-shadow:0 0 6px #22c55e; animation:pulse 1.8s ease-in-out infinite; }
  .af-live-txt { font-size:10px; font-weight:800; color:#22c55e; letter-spacing:1.2px; }

  .af-ticker-wrap { overflow:hidden; height:36px; background:#0f0f0f; border-bottom:1px solid #1a1a1a; display:flex; align-items:center; }
  .af-ticker-track { display:flex; align-items:center; white-space:nowrap; will-change:transform; }
  .af-ticker-item { font-size:11px; font-weight:600; padding:0 4px; letter-spacing:0.3px; }
  .af-ticker-item.green { color:#22c55e; } .af-ticker-item.red { color:#ef4444; } .af-ticker-item.muted { color:#777; }
  .af-tick-sep { color:#2a2a2a; margin-left:10px; }

  .af-note { margin:12px 16px 0; padding:9px 14px; background:rgba(168,85,247,.1); border:1px solid rgba(168,85,247,.3); border-radius:12px; color:#c084fc; font-size:11px; }

  .af-body { display:grid; grid-template-columns:1fr; gap:20px; padding:20px 16px 24px; max-width:1200px; margin:0 auto; }
  @media(min-width:768px){ .af-body{ grid-template-columns:1fr 340px; padding:24px 28px 32px; align-items:start; } }
  @media(min-width:1100px){ .af-body{ grid-template-columns:1fr 380px; padding:28px 40px 40px; } }

  .af-stat-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px; }
  .af-stat-card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:16px; padding:16px 12px 14px; text-align:center; transition:border-color .2s; }
  .af-stat-card:hover { border-color:#3a3a3a; }
  .af-stat-icon { font-size:22px; margin-bottom:8px; }
  .af-stat-num { font-size:20px; font-weight:800; letter-spacing:-.5px; line-height:1.1; }
  .af-stat-lbl { font-size:9px; color:#888; font-weight:600; letter-spacing:.9px; text-transform:uppercase; margin-top:5px; }
  .af-stat-sub { font-size:10px; color:#555; margin-top:3px; }
  @media(min-width:768px){ .af-stat-num{ font-size:24px; } .af-stat-icon{ font-size:26px; } }

  .af-tabs { display:flex; gap:6px; margin-bottom:14px; background:#141414; border-radius:100px; padding:4px; border:1px solid #1e1e1e; }
  .af-tab { flex:1; padding:10px 0; border:none; background:transparent; color:#666; border-radius:100px; font-size:13px; font-weight:600; cursor:pointer; transition:all .2s; display:flex; align-items:center; justify-content:center; gap:6px; font-family:inherit; }
  .af-tab:active { transform:scale(.97); }
  .af-tab.active { background:#4f6ef7; color:#fff; box-shadow:0 2px 18px rgba(79,110,247,.4); }
  .af-tab-badge { font-size:10px; font-weight:800; background:#22c55e; color:#000; border-radius:100px; padding:1px 7px; }

  .af-agent-list { display:flex; flex-direction:column; gap:8px; }
  .af-agent-card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:16px; padding:14px 16px; display:flex; align-items:center; gap:12px; transition:border-color .3s, box-shadow .3s, background .3s; text-decoration:none; color:inherit; }
  .af-agent-card:hover { border-color:#3a3a3a; }
  .af-agent-card.flash { animation:cardFlash .9s ease-out forwards; }
  .af-rank { font-size:11px; color:#444; font-weight:700; min-width:22px; }
  .af-avatar { font-size:28px; line-height:1; flex-shrink:0; }
  .af-agent-info { flex:1; min-width:0; }
  .af-agent-name { font-size:14px; font-weight:700; display:flex; align-items:center; gap:7px; }
  .af-agent-sym { font-size:11px; color:#666; margin-top:2px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-new-badge { font-size:8px; font-weight:800; letter-spacing:1px; background:rgba(168,85,247,.15); color:#c084fc; border:1px solid rgba(168,85,247,.3); border-radius:6px; padding:1px 6px; }
  .af-agent-meta { text-align:right; }
  .af-agent-fee { font-size:16px; font-weight:800; }
  .af-agent-chg { font-size:11px; font-weight:700; margin-top:2px; }
  .af-agent-chg.pos { color:#22c55e; } .af-agent-chg.neg { color:#ef4444; } .af-agent-chg.muted { color:#555; }
  .af-agent-right { text-align:right; min-width:60px; }
  .af-holders { font-size:14px; font-weight:700; color:#ccc; }
  .af-holders-lbl { font-size:9px; color:#555; font-weight:600; letter-spacing:.5px; }
  @media(min-width:768px){ .af-agent-fee{ font-size:18px; } .af-agent-name{ font-size:15px; } .af-avatar{ font-size:30px; } }

  .af-sidebar { position:relative; }
  @media(min-width:768px){ .af-sidebar{ position:sticky; top:80px; max-height:calc(100vh - 100px); overflow-y:auto; } .af-sidebar::-webkit-scrollbar{ width:0; } }
  .af-section-hdr { display:flex; align-items:center; gap:7px; margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #1e1e1e; }
  .af-section-title { font-size:13px; font-weight:700; color:#ccc; }
  .af-feed-list { display:flex; flex-direction:column; gap:6px; }
  .af-feed-empty { font-size:12px; color:#555; padding:14px; text-align:center; }
  .af-feed-card { background:#151515; border:1px solid #1e1e1e; border-radius:12px; padding:11px 12px; display:flex; align-items:center; gap:9px; transition:opacity .4s; }
  .af-feed-card.feed-new { animation:feedSlide .4s ease-out; }
  .af-feed-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .af-feed-icon { font-size:13px; flex-shrink:0; }
  .af-feed-text { flex:1; font-size:12px; color:#bbb; font-weight:500; line-height:1.4; }
  .af-feed-time { font-size:10px; color:#444; font-weight:600; flex-shrink:0; }

  .af-footer { text-align:center; font-size:10px; color:#444; padding:18px; border-top:1px solid #161616; line-height:1.6; }

  @keyframes cardFlash { 0%{ border-color:#4f6ef7; background:rgba(79,110,247,.12); box-shadow:0 0 24px rgba(79,110,247,.3); } 100%{ border-color:#2a2a2a; background:#1a1a1a; box-shadow:none; } }
  @keyframes feedSlide { from{ opacity:0; transform:translateY(-10px); } to{ opacity:1; transform:translateY(0); } }
  @keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:.4; } }
`;
