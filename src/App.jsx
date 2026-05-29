import { useState, useEffect, useRef } from "react";
import {
  loadAgents,
  fetchActivity,
  getTaskCount,
  provider,
  activityText,
  avatarFor,
  short,
  addrUrl,
  txUrl,
  fmtNum,
} from "./lib/onchain";

const BACKFILL_CHUNKS = 14;  // ~126k blocks (~70h) of history for the initial feed
const CHUNK = 9000;
const POLL_MS = 15000;
const NEW_AGENT_WINDOW = 7 * 24 * 3600; // 7 days

function timeAgo(sec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export default function AgentFeed() {
  const [tab, setTab] = useState("leaderboard");
  const [agents, setAgents] = useState([]);
  const [activity, setActivity] = useState([]);
  const [taskCount, setTaskCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tickerOff, setTickerOff] = useState(0);
  const [flashKeys, setFlashKeys] = useState(new Set());

  const lastBlock = useRef(0);
  const seen = useRef(new Set());

  // Recent USDC earned per operator, derived from WorkApproved payout events.
  const earnedByOp = {};
  for (const e of activity) {
    if (e.type === "WorkApproved") {
      const k = e.addr.toLowerCase();
      earnedByOp[k] = (earnedByOp[k] || 0) + e.amount;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const leaderboard = agents; // already sorted by stake desc
  const newAgents = [...agents].sort((a, b) => b.registeredAt - a.registeredAt);
  const newCount = agents.filter((a) => now - a.registeredAt < NEW_AGENT_WINDOW).length;
  const recentPaid = activity.filter((e) => e.type === "WorkApproved").reduce((s, e) => s + e.amount, 0);
  const displayed = tab === "leaderboard" ? leaderboard : newAgents;

  // Initial load: roster (progressive), task count, and backfilled activity.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        getTaskCount().then((c) => !cancelled && setTaskCount(c)).catch(() => {});

        const latest = await provider.getBlockNumber();
        lastBlock.current = latest;
        const from = Math.max(0, latest - BACKFILL_CHUNKS * CHUNK);
        const [, events] = await Promise.all([
          loadAgents((partial) => !cancelled && setAgents(partial)),
          fetchActivity(from, latest),
        ]);
        if (cancelled) return;
        events.forEach((e) => seen.current.add(e.key));
        setActivity(events.slice(0, 40));
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err?.shortMessage || err?.message || "Failed to load on-chain data");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the chain tip for new activity.
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const latest = await provider.getBlockNumber();
        if (latest <= lastBlock.current) return;
        const from = Math.max(lastBlock.current + 1, latest - CHUNK + 1);
        const events = await fetchActivity(from, latest);
        lastBlock.current = latest;
        const fresh = events.filter((e) => !seen.current.has(e.key));
        if (!fresh.length) return;
        fresh.forEach((e) => seen.current.add(e.key));
        setActivity((prev) => [...fresh, ...prev].slice(0, 40));
        setFlashKeys(new Set(fresh.map((e) => e.key)));
        setTimeout(() => setFlashKeys(new Set()), 1000);
      } catch {
        /* transient RPC hiccup; next tick retries */
      }
    }, POLL_MS);
    return () => clearInterval(iv);
  }, []);

  // Ticker animation.
  useEffect(() => {
    const iv = setInterval(() => setTickerOff((p) => p - 1), 22);
    return () => clearInterval(iv);
  }, []);

  const tickerItems = [];
  leaderboard.slice(0, 6).forEach((a) => tickerItems.push(`#${a.id} ${short(a.operator)} · ${fmtNum(a.stake)} AXO`));
  if (recentPaid > 0) tickerItems.push(`💰 $${recentPaid.toFixed(2)} paid out (recent)`);
  if (taskCount != null) tickerItems.push(`📋 ${taskCount} tasks posted`);
  tickerItems.push(`🤖 ${agents.length} agents`);
  const tickerFull = tickerItems.length ? [...tickerItems, ...tickerItems, ...tickerItems] : ["loading on-chain data…"];

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
          <span className="af-pill-icon">⛓️</span>
          <span className="af-pill-val">Base</span>
          <span className="af-pill-lbl">on-chain</span>
          <span className="af-pill-div" />
          <span className="af-live-dot" />
          <span className="af-live-txt">{loading ? "SYNC" : "LIVE"}</span>
        </div>
      </header>

      <div className="af-ticker-wrap">
        <div className="af-ticker-track" style={{ transform: `translateX(${tickerOff % (tickerFull.length * 130)}px)` }}>
          {tickerFull.map((item, i) => (
            <span key={i} className="af-ticker-item muted">
              {item}
              <span className="af-tick-sep">·</span>
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="af-error">⚠️ {error} — retrying via {`mainnet.base.org`}.</div>
      )}

      <div className="af-body">
        <div className="af-main">
          <div className="af-stat-row">
            <div className="af-stat-card">
              <div className="af-stat-icon">🤖</div>
              <div className="af-stat-num">{agents.length || "—"}</div>
              <div className="af-stat-lbl">Registered Agents</div>
              <div className="af-stat-sub">AgentRegistry</div>
            </div>
            <div className="af-stat-card">
              <div className="af-stat-icon">🆕</div>
              <div className="af-stat-num">{newCount}</div>
              <div className="af-stat-lbl">New Agents</div>
              <div className="af-stat-sub">last 7 days</div>
            </div>
            <div className="af-stat-card">
              <div className="af-stat-icon">📋</div>
              <div className="af-stat-num">{taskCount ?? "—"}</div>
              <div className="af-stat-lbl">Tasks Posted</div>
              <div className="af-stat-sub">TaskPool · 5% fee</div>
            </div>
          </div>

          <div className="af-tabs">
            <button className={`af-tab ${tab === "leaderboard" ? "active" : ""}`} onClick={() => setTab("leaderboard")}>
              Stake Leaderboard
            </button>
            <button className={`af-tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>
              New Agents
              {newCount > 0 && <span className="af-tab-badge">{newCount}</span>}
            </button>
          </div>

          <div className="af-agent-list">
            {loading && agents.length === 0 &&
              Array.from({ length: 6 }).map((_, i) => <div key={i} className="af-skeleton" />)}

            {displayed.map((agent, i) => {
              const earned = earnedByOp[agent.operator.toLowerCase()] || 0;
              const isNew = now - agent.registeredAt < NEW_AGENT_WINDOW;
              return (
                <a
                  key={agent.id}
                  href={addrUrl(agent.operator)}
                  target="_blank"
                  rel="noreferrer"
                  className="af-agent-card"
                >
                  <span className="af-rank">#{tab === "leaderboard" ? i + 1 : agent.id}</span>
                  <span className="af-avatar">{avatarFor(agent.operator)}</span>
                  <div className="af-agent-info">
                    <div className="af-agent-name">
                      {short(agent.operator)}
                      {isNew && <span className="af-new-badge">NEW</span>}
                    </div>
                    <div className="af-agent-sym">Agent #{agent.id} · {timeAgo(agent.registeredAt)}</div>
                  </div>
                  <div className="af-agent-meta">
                    <div className="af-agent-fee">{fmtNum(agent.stake)}</div>
                    <div className="af-agent-chg axo">AXO staked</div>
                  </div>
                  <div className="af-agent-right">
                    {earned > 0 ? (
                      <>
                        <div className="af-holders pos">${earned.toFixed(0)}</div>
                        <div className="af-holders-lbl">earned</div>
                      </>
                    ) : (
                      <>
                        <div className="af-holders">{agent.status === 0 ? "●" : "○"}</div>
                        <div className="af-holders-lbl">{agent.status === 0 ? "active" : "idle"}</div>
                      </>
                    )}
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
            {loading && activity.length === 0 &&
              Array.from({ length: 6 }).map((_, i) => <div key={i} className="af-feed-skeleton" />)}
            {!loading && activity.length === 0 && (
              <div className="af-feed-empty">No on-chain events in the recent window.</div>
            )}
            {activity.map((ev, i) => (
              <a
                key={ev.key}
                href={txUrl(ev.txHash)}
                target="_blank"
                rel="noreferrer"
                className={`af-feed-card${flashKeys.has(ev.key) ? " feed-new" : ""}`}
                style={{ opacity: Math.max(0.4, 1 - i * 0.05) }}
              >
                <span className="af-feed-dot" style={{ background: ev.color }} />
                <span className="af-feed-icon">{ev.icon}</span>
                <span className="af-feed-text">{activityText(ev)}</span>
                <span className="af-feed-time">#{ev.blockNumber}</span>
              </a>
            ))}
          </div>
        </div>
      </div>

      <footer className="af-footer">
        Live from Base · AgentRegistry &amp; TaskPool · reads via mainnet.base.org · not affiliated with 0xWork
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

  .af-root {
    background: #0d0d0d; min-height: 100vh;
    font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }

  .af-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px; border-bottom: 1px solid #1e1e1e;
    position: sticky; top: 0; background: rgba(13,13,13,0.95);
    backdrop-filter: blur(12px); z-index: 20;
  }
  .af-logo { display:flex; align-items:center; gap:8px; }
  .af-logo-dot { width:10px; height:10px; border-radius:50%; background:#4f6ef7; box-shadow:0 0 10px #4f6ef7; }
  .af-logo-text { font-size:18px; font-weight:800; letter-spacing:-0.5px; }
  .af-logo-badge {
    font-size:9px; font-weight:800; letter-spacing:1.8px; color:#4f6ef7;
    background:rgba(79,110,247,.12); padding:2px 8px; border-radius:6px; border:1px solid rgba(79,110,247,.25);
  }
  .af-pill { display:flex; align-items:center; gap:5px; background:#1a1a1a; border:1px solid #2a2a2a; border-radius:100px; padding:7px 14px; }
  .af-pill-icon { font-size:13px; }
  .af-pill-val  { font-size:14px; font-weight:700; }
  .af-pill-lbl  { font-size:11px; color:#888; }
  .af-pill-div  { width:1px; height:12px; background:#2a2a2a; margin:0 4px; }
  .af-live-dot  { width:6px; height:6px; border-radius:50%; background:#22c55e; box-shadow:0 0 6px #22c55e; animation: pulse 1.8s ease-in-out infinite; }
  .af-live-txt  { font-size:10px; font-weight:800; color:#22c55e; letter-spacing:1.2px; }

  .af-ticker-wrap { overflow:hidden; height:36px; background:#0f0f0f; border-bottom:1px solid #1a1a1a; display:flex; align-items:center; }
  .af-ticker-track { display:flex; align-items:center; white-space:nowrap; will-change:transform; }
  .af-ticker-item { font-size:11px; font-weight:600; padding:0 4px; letter-spacing:0.3px; }
  .af-ticker-item.muted { color:#777; }
  .af-tick-sep  { color:#2a2a2a; margin-left:10px; }

  .af-error { margin:12px 16px 0; padding:10px 14px; background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.3); border-radius:12px; color:#f87171; font-size:12px; }

  .af-body { display:grid; grid-template-columns: 1fr; gap:20px; padding:20px 16px 24px; max-width:1200px; margin:0 auto; }
  @media(min-width:768px) { .af-body { grid-template-columns: 1fr 340px; padding:24px 28px 32px; align-items:start; } }
  @media(min-width:1100px) { .af-body { grid-template-columns: 1fr 380px; padding:28px 40px 40px; } }

  .af-stat-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px; }
  .af-stat-card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:16px; padding:16px 12px 14px; text-align:center; transition: border-color .2s; }
  .af-stat-card:hover { border-color:#3a3a3a; }
  .af-stat-icon { font-size:22px; margin-bottom:8px; }
  .af-stat-num  { font-size:20px; font-weight:800; letter-spacing:-.5px; line-height:1.1; }
  .af-stat-lbl  { font-size:9px; color:#888; font-weight:600; letter-spacing:.9px; text-transform:uppercase; margin-top:5px; }
  .af-stat-sub  { font-size:10px; color:#555; margin-top:3px; }
  @media(min-width:768px) { .af-stat-num { font-size:24px; } .af-stat-icon{ font-size:26px; } }

  .af-tabs { display:flex; gap:6px; margin-bottom:14px; background:#141414; border-radius:100px; padding:4px; border:1px solid #1e1e1e; }
  .af-tab { flex:1; padding:10px 0; border:none; background:transparent; color:#666; border-radius:100px; font-size:13px; font-weight:600; cursor:pointer; transition:all .2s; display:flex; align-items:center; justify-content:center; gap:6px; font-family:inherit; }
  .af-tab:active { transform:scale(.97); }
  .af-tab.active { background:#4f6ef7; color:#fff; box-shadow:0 2px 18px rgba(79,110,247,.4); }
  .af-tab-badge { font-size:10px; font-weight:800; background:#22c55e; color:#000; border-radius:100px; padding:1px 7px; }

  .af-agent-list { display:flex; flex-direction:column; gap:8px; }
  .af-agent-card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:16px; padding:14px 16px; display:flex; align-items:center; gap:12px; transition:border-color .3s, box-shadow .3s, background .3s; text-decoration:none; color:inherit; }
  .af-agent-card:hover { border-color:#3a3a3a; }
  .af-rank { font-size:11px; color:#444; font-weight:700; min-width:34px; }
  .af-avatar { font-size:28px; line-height:1; flex-shrink:0; }
  .af-agent-info { flex:1; min-width:0; }
  .af-agent-name { font-size:14px; font-weight:700; display:flex; align-items:center; gap:7px; font-variant-numeric:tabular-nums; }
  .af-agent-sym { font-size:11px; color:#555; margin-top:2px; font-weight:600; }
  .af-new-badge { font-size:8px; font-weight:800; letter-spacing:1px; background:rgba(168,85,247,.15); color:#c084fc; border:1px solid rgba(168,85,247,.3); border-radius:6px; padding:1px 6px; }
  .af-agent-meta { text-align:right; }
  .af-agent-fee  { font-size:16px; font-weight:800; }
  .af-agent-chg  { font-size:10px; font-weight:700; margin-top:2px; color:#888; letter-spacing:.4px; }
  .af-agent-chg.axo { color:#4f6ef7; }
  .af-agent-right { text-align:right; min-width:52px; }
  .af-holders { font-size:14px; font-weight:700; color:#ccc; }
  .af-holders.pos { color:#22c55e; }
  .af-holders-lbl { font-size:9px; color:#555; font-weight:600; letter-spacing:.5px; }
  @media(min-width:768px) { .af-agent-fee { font-size:18px; } .af-agent-name { font-size:15px; } .af-avatar { font-size:30px; } }

  .af-skeleton { height:66px; border-radius:16px; background:linear-gradient(90deg,#161616,#1d1d1d,#161616); background-size:200% 100%; animation: shimmer 1.3s infinite; }
  .af-feed-skeleton { height:44px; border-radius:12px; background:linear-gradient(90deg,#141414,#1a1a1a,#141414); background-size:200% 100%; animation: shimmer 1.3s infinite; }
  .af-feed-empty { font-size:12px; color:#555; padding:14px; text-align:center; }

  .af-sidebar { position:relative; }
  @media(min-width:768px) { .af-sidebar { position:sticky; top:80px; max-height:calc(100vh - 100px); overflow-y:auto; } .af-sidebar::-webkit-scrollbar { width:0; } }
  .af-section-hdr { display:flex; align-items:center; gap:7px; margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #1e1e1e; }
  .af-section-title { font-size:13px; font-weight:700; color:#ccc; }
  .af-feed-list { display:flex; flex-direction:column; gap:6px; }
  .af-feed-card { background:#151515; border:1px solid #1e1e1e; border-radius:12px; padding:11px 12px; display:flex; align-items:center; gap:9px; transition:opacity .4s; text-decoration:none; color:inherit; }
  .af-feed-card:hover { border-color:#2a2a2a; }
  .af-feed-card.feed-new { animation: feedSlide .4s ease-out; border-color:rgba(79,110,247,.4); }
  .af-feed-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .af-feed-icon { font-size:13px; flex-shrink:0; }
  .af-feed-text { flex:1; font-size:12px; color:#bbb; font-weight:500; line-height:1.4; font-variant-numeric:tabular-nums; }
  .af-feed-time { font-size:10px; color:#444; font-weight:600; flex-shrink:0; }

  .af-footer { text-align:center; font-size:10px; color:#444; padding:18px; border-top:1px solid #161616; }

  @keyframes feedSlide { from { opacity:0; transform:translateY(-10px); } to { opacity:1; transform:translateY(0); } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
  @keyframes shimmer { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
`;
