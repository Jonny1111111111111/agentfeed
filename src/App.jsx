import { useState, useEffect, useRef } from "react";

const AGENTS = [
  { id: 1, name: "SHANKY",  symbol: "$SHANKY", avatar: "🦈", price: 0.00412, fees: 1842,  volume: 94200,  holders: 312,  change: +18.4, isNew: false },
  { id: 2, name: "MARHEEL", symbol: "$MRH",    avatar: "🤖", price: 0.00871, fees: 3210,  volume: 187600, holders: 891,  change: +42.1, isNew: true  },
  { id: 3, name: "AXOBOTL", symbol: "$AXBT",   avatar: "🐙", price: 0.00234, fees: 980,   volume: 52100,  holders: 204,  change: -6.3,  isNew: false },
  { id: 4, name: "VAULTEX", symbol: "$VLT",    avatar: "🔐", price: 0.01120, fees: 5640,  volume: 310000, holders: 1420, change: +9.7,  isNew: false },
  { id: 5, name: "DRIFTER", symbol: "$DFT",    avatar: "🌊", price: 0.00088, fees: 441,   volume: 28400,  holders: 97,   change: -14.2, isNew: true  },
  { id: 6, name: "LIQUIFY", symbol: "$LQF",    avatar: "💧", price: 0.00655, fees: 2870,  volume: 142000, holders: 673,  change: +5.8,  isNew: false },
  { id: 7, name: "NEUROQ",  symbol: "$NRQ",    avatar: "🧠", price: 0.00310, fees: 1560,  volume: 81000,  holders: 388,  change: +27.3, isNew: true  },
  { id: 8, name: "FLUXOR",  symbol: "$FLX",    avatar: "⚡", price: 0.00540, fees: 2210,  volume: 118000, holders: 519,  change: -2.1,  isNew: false },
];

const TICKER_ITEMS = [
  "$SHANKY +18.4%","$MARHEEL +42.1%","$VAULTEX +9.7%","$NEUROQ +27.3%",
  "$AXOBOTL -6.3%","$DRIFTER -14.2%","$LIQUIFY +5.8%","$FLUXOR -2.1%",
  "🔥 New: $MARHEEL","🔥 New: $NEUROQ","Total Vol: $1.01M",
];

function fmt(n) {
  if (n >= 1000000) return (n/1000000).toFixed(2)+"M";
  if (n >= 1000)    return (n/1000).toFixed(1)+"K";
  return n.toString();
}

function generateEvent(agents) {
  const agent = agents[Math.floor(Math.random()*agents.length)];
  const types = ["fee","fee","fee","launch","holder"];
  const type  = types[Math.floor(Math.random()*types.length)];
  const time  = new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
  if (type==="fee") {
    const amt = (Math.random()*180+20).toFixed(0);
    return {id:Date.now()+Math.random(),agentId:agent.id,type:"fee",   text:`${agent.avatar} ${agent.name} earned $${amt} in fees`,  time,color:"#4f6ef7"};
  } else if (type==="launch") {
    return {id:Date.now()+Math.random(),agentId:agent.id,type:"launch",text:`🚀 ${agent.name} new task launched`,                   time,color:"#22c55e"};
  } else {
    const n = Math.floor(Math.random()*20+1);
    return {id:Date.now()+Math.random(),agentId:agent.id,type:"holder",text:`👤 +${n} new holders joined ${agent.name}`,            time,color:"#f59e0b"};
  }
}

export default function AgentFeed() {
  const [tab,        setTab]        = useState("leaderboard");
  const [liveEvents, setLiveEvents] = useState([]);
  const [flashIds,   setFlashIds]   = useState(new Set());
  const [tickerOff,  setTickerOff]  = useState(0);

  const sortedByFee = [...AGENTS].sort((a,b)=>b.fees-a.fees);
  const newAgents   = AGENTS.filter(a=>a.isNew);
  const displayed   = tab==="leaderboard" ? sortedByFee : newAgents;
  const totalVol    = AGENTS.reduce((s,a)=>s+a.volume,0);
  const topAgent    = sortedByFee[0];

  // Ticker
  useEffect(()=>{
    const iv = setInterval(()=>setTickerOff(p=>p-1), 22);
    return ()=>clearInterval(iv);
  },[]);

  // Live feed
  useEffect(()=>{
    setLiveEvents(Array.from({length:5},()=>generateEvent(AGENTS)));
    const iv = setInterval(()=>{
      const ev = generateEvent(AGENTS);
      setLiveEvents(prev=>[ev,...prev].slice(0,25));
      setFlashIds(prev=>{ const n=new Set(prev); n.add(ev.agentId); return n; });
      setTimeout(()=>setFlashIds(prev=>{ const n=new Set(prev); n.delete(ev.agentId); return n; }),900);
    },3000);
    return ()=>clearInterval(iv);
  },[]);

  const tickerFull = [...TICKER_ITEMS,...TICKER_ITEMS,...TICKER_ITEMS];

  return (
    <div className="af-root">
      <style>{CSS}</style>

      {/* ── Header ── */}
      <header className="af-header">
        <div className="af-logo">
          <span className="af-logo-dot"/>
          <span className="af-logo-text">0xWork</span>
          <span className="af-logo-badge">FEED</span>
        </div>
        <div className="af-pill">
          <span className="af-pill-icon">⚡</span>
          <span className="af-pill-val">2,847</span>
          <span className="af-pill-lbl">pts</span>
          <span className="af-pill-div"/>
          <span className="af-live-dot"/>
          <span className="af-live-txt">LIVE</span>
        </div>
      </header>

      {/* ── Ticker ── */}
      <div className="af-ticker-wrap">
        <div className="af-ticker-track" style={{transform:`translateX(${tickerOff%(tickerFull.length*140)}px)`}}>
          {tickerFull.map((item,i)=>(
            <span key={i} className={`af-ticker-item ${item.includes("-")?"red":item.includes("+")?"green":"muted"}`}>
              {item}<span className="af-tick-sep">·</span>
            </span>
          ))}
        </div>
      </div>

      {/* ── Body: two-column on desktop ── */}
      <div className="af-body">

        {/* LEFT / MAIN COLUMN */}
        <div className="af-main">

          {/* Stat cards */}
          <div className="af-stat-row">
            <div className="af-stat-card">
              <div className="af-stat-icon">{topAgent.avatar}</div>
              <div className="af-stat-num">${fmt(topAgent.fees)}</div>
              <div className="af-stat-lbl">Top Fee Agent</div>
              <div className="af-stat-sub">{topAgent.name}</div>
            </div>
            <div className="af-stat-card">
              <div className="af-stat-icon">🆕</div>
              <div className="af-stat-num">{newAgents.length}</div>
              <div className="af-stat-lbl">New Agents</div>
              <div className="af-stat-sub">this epoch</div>
            </div>
            <div className="af-stat-card">
              <div className="af-stat-icon">📊</div>
              <div className="af-stat-num">${fmt(totalVol)}</div>
              <div className="af-stat-lbl">Total Volume</div>
              <div className="af-stat-sub">24h</div>
            </div>
          </div>

          {/* Tabs */}
          <div className="af-tabs">
            <button className={`af-tab ${tab==="leaderboard"?"active":""}`} onClick={()=>setTab("leaderboard")}>
              Fee Leaderboard
            </button>
            <button className={`af-tab ${tab==="new"?"active":""}`} onClick={()=>setTab("new")}>
              New Agents
              {newAgents.length>0 && <span className="af-tab-badge">{newAgents.length}</span>}
            </button>
          </div>

          {/* Agent list */}
          <div className="af-agent-list">
            {displayed.map((agent,i)=>(
              <div key={agent.id} className={`af-agent-card${flashIds.has(agent.id)?" flash":""}`}>
                <span className="af-rank">#{i+1}</span>
                <span className="af-avatar">{agent.avatar}</span>
                <div className="af-agent-info">
                  <div className="af-agent-name">
                    {agent.name}
                    {agent.isNew && <span className="af-new-badge">NEW</span>}
                  </div>
                  <div className="af-agent-sym">{agent.symbol}</div>
                </div>
                <div className="af-agent-meta">
                  <div className="af-agent-fee">${fmt(agent.fees)}</div>
                  <div className={`af-agent-chg ${agent.change>=0?"pos":"neg"}`}>
                    {agent.change>=0?"▲":"▼"} {Math.abs(agent.change)}%
                  </div>
                </div>
                <div className="af-agent-right">
                  <div className="af-holders">{fmt(agent.holders)}</div>
                  <div className="af-holders-lbl">holders</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT / FEED COLUMN (desktop sidebar, mobile below) */}
        <div className="af-sidebar">
          <div className="af-section-hdr">
            <span className="af-section-title">Live Activity</span>
            <span className="af-live-dot"/>
            <span className="af-live-txt">LIVE</span>
          </div>
          <div className="af-feed-list">
            {liveEvents.map((ev,i)=>(
              <div key={ev.id}
                className={`af-feed-card${i===0?" feed-new":""}`}
                style={{opacity: Math.max(0.35, 1-i*0.055)}}>
                <span className="af-feed-dot" style={{background:ev.color}}/>
                <span className="af-feed-text">{ev.text}</span>
                <span className="af-feed-time">{ev.time}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
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
    background: #0d0d0d;
    min-height: 100vh;
    font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }

  /* ── HEADER ── */
  .af-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid #1e1e1e;
    position: sticky; top: 0;
    background: rgba(13,13,13,0.95);
    backdrop-filter: blur(12px);
    z-index: 20;
  }
  .af-logo { display:flex; align-items:center; gap:8px; }
  .af-logo-dot {
    width:10px; height:10px; border-radius:50%;
    background:#4f6ef7; box-shadow:0 0 10px #4f6ef7;
  }
  .af-logo-text { font-size:18px; font-weight:800; letter-spacing:-0.5px; }
  .af-logo-badge {
    font-size:9px; font-weight:800; letter-spacing:1.8px;
    color:#4f6ef7; background:rgba(79,110,247,.12);
    padding:2px 8px; border-radius:6px; border:1px solid rgba(79,110,247,.25);
  }
  .af-pill {
    display:flex; align-items:center; gap:5px;
    background:#1a1a1a; border:1px solid #2a2a2a;
    border-radius:100px; padding:7px 14px;
  }
  .af-pill-icon { font-size:13px; }
  .af-pill-val  { font-size:14px; font-weight:700; }
  .af-pill-lbl  { font-size:11px; color:#888; }
  .af-pill-div  { width:1px; height:12px; background:#2a2a2a; margin:0 4px; }
  .af-live-dot  {
    width:6px; height:6px; border-radius:50%;
    background:#22c55e; box-shadow:0 0 6px #22c55e;
    animation: pulse 1.8s ease-in-out infinite;
  }
  .af-live-txt  { font-size:10px; font-weight:800; color:#22c55e; letter-spacing:1.2px; }

  /* ── TICKER ── */
  .af-ticker-wrap {
    overflow:hidden; height:36px;
    background:#0f0f0f; border-bottom:1px solid #1a1a1a;
    display:flex; align-items:center;
  }
  .af-ticker-track {
    display:flex; align-items:center;
    white-space:nowrap; will-change:transform;
  }
  .af-ticker-item { font-size:11px; font-weight:600; padding:0 4px; letter-spacing:0.3px; }
  .af-ticker-item.green { color:#22c55e; }
  .af-ticker-item.red   { color:#ef4444; }
  .af-ticker-item.muted { color:#555; }
  .af-tick-sep  { color:#2a2a2a; margin-left:10px; }

  /* ── BODY LAYOUT ── */
  .af-body {
    display:grid;
    grid-template-columns: 1fr;        /* mobile: single column */
    gap:20px;
    padding:20px 16px 40px;
    max-width:1200px;
    margin:0 auto;
  }
  @media(min-width:768px) {
    .af-body {
      grid-template-columns: 1fr 340px; /* desktop: main + sidebar */
      padding:24px 28px 48px;
      align-items:start;
    }
  }
  @media(min-width:1100px) {
    .af-body {
      grid-template-columns: 1fr 380px;
      padding:28px 40px 56px;
    }
  }

  /* ── STAT CARDS ── */
  .af-stat-row {
    display:grid;
    grid-template-columns:repeat(3,1fr);
    gap:10px; margin-bottom:20px;
  }
  .af-stat-card {
    background:#1a1a1a; border:1px solid #2a2a2a;
    border-radius:16px; padding:16px 12px 14px;
    text-align:center;
    transition: border-color .2s;
  }
  .af-stat-card:hover { border-color:#3a3a3a; }
  .af-stat-icon { font-size:22px; margin-bottom:8px; }
  .af-stat-num  { font-size:20px; font-weight:800; letter-spacing:-.5px; line-height:1.1; }
  .af-stat-lbl  {
    font-size:9px; color:#888; font-weight:600;
    letter-spacing:.9px; text-transform:uppercase; margin-top:5px;
  }
  .af-stat-sub  { font-size:10px; color:#555; margin-top:3px; }
  @media(min-width:768px) {
    .af-stat-num { font-size:24px; }
    .af-stat-icon{ font-size:26px; }
  }

  /* ── TABS ── */
  .af-tabs {
    display:flex; gap:6px; margin-bottom:14px;
    background:#141414; border-radius:100px;
    padding:4px; border:1px solid #1e1e1e;
  }
  .af-tab {
    flex:1; padding:10px 0;
    border:none; background:transparent; color:#666;
    border-radius:100px; font-size:13px; font-weight:600;
    cursor:pointer; transition:all .2s;
    display:flex; align-items:center; justify-content:center; gap:6px;
    font-family:inherit;
  }
  .af-tab:active { transform:scale(.97); }
  .af-tab.active {
    background:#4f6ef7; color:#fff;
    box-shadow:0 2px 18px rgba(79,110,247,.4);
  }
  .af-tab-badge {
    font-size:10px; font-weight:800;
    background:#22c55e; color:#000;
    border-radius:100px; padding:1px 7px;
  }

  /* ── AGENT CARDS ── */
  .af-agent-list { display:flex; flex-direction:column; gap:8px; }
  .af-agent-card {
    background:#1a1a1a; border:1px solid #2a2a2a;
    border-radius:16px; padding:14px 16px;
    display:flex; align-items:center; gap:12px;
    transition:border-color .3s, box-shadow .3s, background .3s;
    cursor:default;
  }
  .af-agent-card:hover { border-color:#333; }
  .af-agent-card.flash {
    animation: cardFlash 0.9s ease-out forwards;
  }
  .af-rank   { font-size:11px; color:#444; font-weight:700; min-width:22px; }
  .af-avatar { font-size:28px; line-height:1; flex-shrink:0; }
  .af-agent-info { flex:1; min-width:0; }
  .af-agent-name {
    font-size:14px; font-weight:700;
    display:flex; align-items:center; gap:7px;
  }
  .af-agent-sym { font-size:11px; color:#555; margin-top:2px; font-weight:600; }
  .af-new-badge {
    font-size:8px; font-weight:800; letter-spacing:1px;
    background:rgba(34,197,94,.15); color:#22c55e;
    border:1px solid rgba(34,197,94,.3);
    border-radius:6px; padding:1px 6px;
  }
  .af-agent-meta { text-align:right; }
  .af-agent-fee  { font-size:16px; font-weight:800; }
  .af-agent-chg  { font-size:11px; font-weight:700; margin-top:2px; }
  .af-agent-chg.pos { color:#22c55e; }
  .af-agent-chg.neg { color:#ef4444; }
  .af-agent-right { text-align:right; min-width:52px; }
  .af-holders     { font-size:14px; font-weight:700; color:#ccc; }
  .af-holders-lbl { font-size:9px; color:#555; font-weight:600; letter-spacing:.5px; }

  @media(min-width:768px) {
    .af-agent-fee  { font-size:18px; }
    .af-agent-name { font-size:15px; }
    .af-avatar     { font-size:30px; }
  }

  /* ── SIDEBAR / LIVE FEED ── */
  .af-sidebar {
    position:relative;
  }
  @media(min-width:768px) {
    .af-sidebar {
      position:sticky;
      top:80px;
      max-height:calc(100vh - 100px);
      overflow-y:auto;
    }
    .af-sidebar::-webkit-scrollbar { width:0; }
  }
  .af-section-hdr {
    display:flex; align-items:center; gap:7px;
    margin-bottom:10px; padding-bottom:10px;
    border-bottom:1px solid #1e1e1e;
  }
  .af-section-title { font-size:13px; font-weight:700; color:#ccc; }
  .af-feed-list { display:flex; flex-direction:column; gap:6px; }
  .af-feed-card {
    background:#151515; border:1px solid #1e1e1e;
    border-radius:12px; padding:11px 14px;
    display:flex; align-items:center; gap:10px;
    transition:opacity .4s;
  }
  .af-feed-card.feed-new {
    animation: feedSlide .3s ease-out;
  }
  .af-feed-dot  { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .af-feed-text { flex:1; font-size:12px; color:#bbb; font-weight:500; line-height:1.4; }
  .af-feed-time { font-size:10px; color:#444; font-weight:600; flex-shrink:0; }

  /* ── ANIMATIONS ── */
  @keyframes cardFlash {
    0%   { border-color:#4f6ef7; background:rgba(79,110,247,.12); box-shadow:0 0 24px rgba(79,110,247,.3); }
    100% { border-color:#2a2a2a; background:#1a1a1a; box-shadow:none; }
  }
  @keyframes feedSlide {
    from { opacity:0; transform:translateY(-10px); }
    to   { opacity:1; transform:translateY(0); }
  }
  @keyframes pulse {
    0%,100% { opacity:1; }
    50%      { opacity:.4; }
  }
`;
