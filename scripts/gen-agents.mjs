// Build-time snapshot of registered 0xWork agents.
//
// GET https://api.0xwork.org/agents is CORS-blocked (same-origin policy), so the
// browser can't read it directly — we paginate it server-side at build time and
// write src/data/agents.json. Each agent is joined to any token launches it made
// (matched via operator_address / agent id / chain_agent_id against the launches
// API; only verified launches carry these, so most agents have no linked token).
import fs from "fs";
import path from "path";

const AGENTS_URL = "https://api.0xwork.org/agents";
const LAUNCHES_URL = "https://api.0xwork.org/agent/token/launches";
const OUT = path.resolve("src/data/agents.json");
const PAGE = 200;

async function fetchAllAgents() {
  let agents = [];
  let total = Infinity;
  for (let off = 0; off < total; off += PAGE) {
    const res = await fetch(`${AGENTS_URL}?limit=${PAGE}&offset=${off}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`agents HTTP ${res.status}`);
    const j = await res.json();
    total = j.total ?? (j.agents || []).length;
    agents = agents.concat(j.agents || []);
    if (!(j.agents || []).length) break;
  }
  return { agents, total };
}

async function fetchLaunchIndex() {
  const byOperator = new Map();
  const byAgentId = new Map();
  const byChainAgentId = new Map();
  const push = (map, key, tok) => {
    if (key == null) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tok);
  };
  let total = Infinity;
  for (let off = 0; off < total; off += 50) {
    const res = await fetch(`${LAUNCHES_URL}?limit=50&offset=${off}`, { headers: { accept: "application/json" } });
    if (!res.ok) break;
    const j = await res.json();
    total = j.total ?? (j.items || []).length;
    for (const i of j.items || []) {
      const tok = { tokenSymbol: i.tokenSymbol, tokenName: i.tokenName, tokenAddress: i.tokenAddress };
      push(byOperator, i.launcher?.operatorAddress?.toLowerCase(), tok);
      push(byAgentId, i.launcher?.agentId, tok);
      push(byChainAgentId, i.launcher?.chainAgentId, tok);
    }
  }
  return { byOperator, byAgentId, byChainAgentId };
}

function parseCapabilities(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function tokensFor(a, idx) {
  const seen = new Map();
  const add = (list) => {
    for (const t of list || []) if (t.tokenAddress && !seen.has(t.tokenAddress.toLowerCase())) seen.set(t.tokenAddress.toLowerCase(), t);
  };
  add(idx.byOperator.get(a.operator_address?.toLowerCase()));
  add(idx.byAgentId.get(a.id));
  add(idx.byChainAgentId.get(a.chain_agent_id));
  return [...seen.values()];
}

try {
  const [{ agents: raw, total }, idx] = await Promise.all([fetchAllAgents(), fetchLaunchIndex()]);
  const agents = raw.map((a) => ({
    id: a.id,
    chainAgentId: a.chain_agent_id ?? null,
    operatorAddress: a.operator_address ?? null,
    name: a.agent_name || null,
    handle: a.handle || a.verified_x_handle || null,
    status: a.status || "Unknown",
    reputation: a.computed_reputation ?? a.reputation ?? 0,
    tasksCompleted: a.tasks_completed ?? 0,
    tasksFailed: a.tasks_failed ?? 0,
    totalEarned: Number(a.total_earned) || 0,
    successRate: a.success_rate ?? null,
    // Staking tier is derived from staked tokens (0xWork thresholds: 50k Silver, 100k Gold, 500k Platinum).
    staked: a.staked_amount ? Math.round(Number(a.staked_amount) / 1e18) : 0,
    registeredAt: a.registered_at ?? null,
    image: a.image || null,
    description: a.description || null,
    capabilities: parseCapabilities(a.capabilities),
    verified: !!a.verified_x_handle,
    profileUrl: a.operator_address ? `https://0xwork.org/agents/${a.operator_address}` : null,
    tokens: tokensFor(a, idx),
  }));
  // Rank by reputation, then earnings.
  agents.sort((x, y) => y.reputation - x.reputation || y.totalEarned - x.totalEarned);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total, count: agents.length, agents }, null, 2));
  const linked = agents.filter((a) => a.tokens.length).length;
  console.log(`[gen-agents] wrote ${agents.length}/${total} agents (${linked} with linked tokens) -> ${OUT}`);
} catch (err) {
  if (fs.existsSync(OUT)) {
    console.warn(`[gen-agents] fetch failed (${err.message}); keeping existing snapshot.`);
  } else {
    console.error(`[gen-agents] fetch failed (${err.message}); writing empty.`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: 0, count: 0, agents: [] }, null, 2));
  }
  process.exit(0);
}
