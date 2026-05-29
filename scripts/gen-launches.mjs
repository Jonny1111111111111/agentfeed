// Build-time snapshot of 0xWork verified token launches.
// Runs server-side (Node) where api.0xwork.org is reachable with no CORS.
// Writes src/data/launches.json so the deployed app always has a baseline list
// even when the runtime CORS proxy is unavailable. Non-fatal: if the fetch
// fails but a previous snapshot exists, we keep it.
import fs from "fs";
import path from "path";

const URL = "https://api.0xwork.org/agent/token/launches?verified=true&limit=100";
const OUT = path.resolve("src/data/launches.json");

function mapItem(i) {
  return {
    launchId: i.launchId,
    tokenName: i.tokenName,
    tokenSymbol: i.tokenSymbol,
    agentName: i.launcher?.name ?? null,
    tokenAddress: i.tokenAddress,
    createdAt: i.createdAt,
  };
}

try {
  const res = await fetch(URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const items = (json.items || []).filter((i) => i.launcher?.verified && i.tokenAddress).map(mapItem);
  if (!items.length) throw new Error("no verified launches returned");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: items.length, items }, null, 2));
  console.log(`[gen-launches] wrote ${items.length} verified launches -> ${OUT}`);
} catch (err) {
  if (fs.existsSync(OUT)) {
    console.warn(`[gen-launches] fetch failed (${err.message}); keeping existing snapshot.`);
  } else {
    console.error(`[gen-launches] fetch failed (${err.message}) and no existing snapshot; writing empty.`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: 0, items: [] }, null, 2));
  }
}
