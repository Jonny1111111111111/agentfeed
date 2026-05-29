// On-chain data layer for the 0xWork AgentFeed dashboard.
//
// All reads go through Base's public RPC (https://mainnet.base.org), which has
// permissive CORS — unlike api.0xwork.org, whose REST routes send
// `Cross-Origin-Resource-Policy: same-origin` and would be blocked in-browser.
//
// Verified facts that shape this module (checked against the live chain):
//  - AgentRegistry.agents(id) exposes operator/stake/registeredAt/status on-chain,
//    but tasksCompleted/totalEarned are NOT maintained on-chain (always 0). Those
//    aggregates only exist in the off-chain REST API. So the leaderboard ranks by
//    staked $AXOBOTL, and real USDC payouts come from TaskPool WorkApproved events.
//  - Base public RPC caps eth_getLogs at ~10k blocks per call -> we chunk at 9000.
//  - Multicall3 (0xcA11…CA11) is deployed on Base; we batch getAgent() through it.
import { ethers } from "ethers";

export const RPC_URL = "https://mainnet.base.org";
export const CHAIN_ID = 8453;

export const ADDR = {
  agentRegistry: "0x14e50557d7d28274368E28C711e3581AdcF56b05",
  taskPool: "0xF404aFdbA46e05Af7B395FB45c43e66dB549C6D2",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  axobotl: "0x810affc8aadad2824c65e0a2c5ef96ef1de42ba3",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export const USDC_DECIMALS = 6;
export const AXO_DECIMALS = 18;
const LOG_CHUNK = 9000; // < 10k Base RPC getLogs cap

const AGENT_REGISTRY_ABI = [
  "function agentCount() view returns (uint256)",
  "function getAgent(uint256) view returns (tuple(address operator,string metadataURI,uint256 stakedAmount,uint256 registeredAt,uint256 tasksCompleted,uint256 tasksFailed,uint256 totalEarned,uint8 status))",
  "event AgentRegistered(uint256 indexed agentId, address indexed operator, uint256 stakeAmount, string metadataURI)",
];

const TASK_POOL_ABI = [
  "function taskCount() view returns (uint256)",
  "event TaskPosted(uint256 indexed taskId, address indexed poster, uint256 bountyAmount, uint256 deadline)",
  "event TaskClaimed(uint256 indexed taskId, address indexed worker, uint256 stakeAmount)",
  "event WorkApproved(uint256 indexed taskId, address indexed worker, uint256 payout)",
];

const MULTICALL3_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
];

export const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });

const arIface = new ethers.Interface(AGENT_REGISTRY_ABI);
const tpIface = new ethers.Interface(TASK_POOL_ABI);
const multicall = new ethers.Contract(ADDR.multicall3, MULTICALL3_ABI, provider);

export const TOPICS = {
  AgentRegistered: ethers.id("AgentRegistered(uint256,address,uint256,string)"),
  TaskPosted: ethers.id("TaskPosted(uint256,address,uint256,uint256)"),
  TaskClaimed: ethers.id("TaskClaimed(uint256,address,uint256)"),
  WorkApproved: ethers.id("WorkApproved(uint256,address,uint256)"),
};

export const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
export const txUrl = (hash) => `https://basescan.org/tx/${hash}`;
export const addrUrl = (addr) => `https://basescan.org/address/${addr}`;

// Deterministic emoji avatar from an address (stable per operator).
const AVATARS = ["🦈", "🤖", "🐙", "🔐", "🌊", "💧", "🧠", "⚡", "🦾", "🛰️", "🔮", "🎯", "🧩", "🚀", "🦉", "🐬"];
export function avatarFor(addr) {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export const fmtUsdc = (v) => Number(ethers.formatUnits(v, USDC_DECIMALS));
export const fmtAxo = (v) => Number(ethers.formatUnits(v, AXO_DECIMALS));

export function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Read TaskPool.taskCount(). */
export async function getTaskCount() {
  const tp = new ethers.Contract(ADDR.taskPool, TASK_POOL_ABI, provider);
  return Number(await tp.taskCount());
}

/**
 * Load the full agent roster via Multicall3, batched so the UI can render
 * progressively. Calls onBatch(partialSortedArray) as batches resolve.
 */
export async function loadAgents(onBatch) {
  const ar = new ethers.Contract(ADDR.agentRegistry, AGENT_REGISTRY_ABI, provider);
  const count = Number(await ar.agentCount());
  const BATCH = 50;
  const agents = [];

  for (let start = 1; start <= count; start += BATCH) {
    const end = Math.min(start + BATCH - 1, count);
    const calls = [];
    for (let id = start; id <= end; id++) {
      calls.push({
        target: ADDR.agentRegistry,
        allowFailure: true,
        callData: arIface.encodeFunctionData("getAgent", [BigInt(id)]),
      });
    }
    const res = await multicall.aggregate3(calls);
    res.forEach((r, i) => {
      if (!r.success) return;
      let d;
      try {
        d = arIface.decodeFunctionResult("getAgent", r.returnData)[0];
      } catch {
        return;
      }
      if (d.operator === ethers.ZeroAddress) return;
      agents.push({
        id: start + i,
        operator: d.operator,
        stake: fmtAxo(d.stakedAmount),
        registeredAt: Number(d.registeredAt),
        tasksCompleted: Number(d.tasksCompleted),
        tasksFailed: Number(d.tasksFailed),
        totalEarned: fmtUsdc(d.totalEarned),
        status: Number(d.status),
      });
    });
    if (onBatch) onBatch([...agents].sort((a, b) => b.stake - a.stake));
  }
  return agents.sort((a, b) => b.stake - a.stake);
}

/**
 * Fetch & decode activity events between [fromBlock, toBlock], chunked to
 * respect the RPC's 10k-block getLogs cap. Returns newest-first.
 */
export async function fetchActivity(fromBlock, toBlock) {
  const out = [];
  for (let to = toBlock; to >= fromBlock; to -= LOG_CHUNK) {
    const from = Math.max(fromBlock, to - LOG_CHUNK + 1);
    const [tpLogs, arLogs] = await Promise.all([
      provider.getLogs({
        address: ADDR.taskPool,
        fromBlock: from,
        toBlock: to,
        topics: [[TOPICS.TaskPosted, TOPICS.TaskClaimed, TOPICS.WorkApproved]],
      }),
      provider.getLogs({
        address: ADDR.agentRegistry,
        fromBlock: from,
        toBlock: to,
        topics: [TOPICS.AgentRegistered],
      }),
    ]);
    for (const l of tpLogs) out.push(decodeTp(l));
    for (const l of arLogs) out.push(decodeAr(l));
    if (from === fromBlock) break;
  }
  return out
    .filter(Boolean)
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
}

function baseFields(l) {
  return { key: `${l.transactionHash}:${l.logIndex}`, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash };
}

function decodeTp(l) {
  let p;
  try { p = tpIface.parseLog(l); } catch { return null; }
  const b = baseFields(l);
  if (p.name === "TaskPosted")
    return { ...b, type: "TaskPosted", color: "#22c55e", icon: "🚀", taskId: Number(p.args.taskId), addr: p.args.poster, amount: fmtUsdc(p.args.bountyAmount) };
  if (p.name === "TaskClaimed")
    return { ...b, type: "TaskClaimed", color: "#4f6ef7", icon: "🤝", taskId: Number(p.args.taskId), addr: p.args.worker, amount: fmtAxo(p.args.stakeAmount) };
  if (p.name === "WorkApproved")
    return { ...b, type: "WorkApproved", color: "#f59e0b", icon: "💰", taskId: Number(p.args.taskId), addr: p.args.worker, amount: fmtUsdc(p.args.payout) };
  return null;
}

function decodeAr(l) {
  let p;
  try { p = arIface.parseLog(l); } catch { return null; }
  const b = baseFields(l);
  if (p.name === "AgentRegistered")
    return { ...b, type: "AgentRegistered", color: "#a855f7", icon: "🆕", agentId: Number(p.args.agentId), addr: p.args.operator, amount: fmtAxo(p.args.stakeAmount) };
  return null;
}

export function activityText(e) {
  switch (e.type) {
    case "TaskPosted": return `${short(e.addr)} posted task #${e.taskId} · $${e.amount.toFixed(2)} bounty`;
    case "TaskClaimed": return `${short(e.addr)} claimed task #${e.taskId} · ${fmtNum(e.amount)} AXO staked`;
    case "WorkApproved": return `${short(e.addr)} earned $${e.amount.toFixed(2)} on task #${e.taskId}`;
    case "AgentRegistered": return `Agent #${e.agentId} registered · ${short(e.addr)}`;
    default: return e.type;
  }
}
