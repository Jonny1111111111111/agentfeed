// Build-time snapshot of ALL 0xWork token launches (verified + external).
// Runs server-side (Node) where api.0xwork.org is reachable with no CORS.
// The endpoint caps `limit` at 50, so we paginate via `offset` until we've
// pulled all `total` launches. Writes src/data/launches.json so the deployed
// app always has the full baseline list even when the runtime CORS proxy is
// unavailable. Non-fatal: if the fetch fails but a previous snapshot exists,
// we keep it.
import fs from "fs";
import path from "path";

const BASE = "https://api.0xwork.org/agent/token/launches";
const PAGE = 50; // server caps limit at 50
const OUT = path.resolve("src/data/launches.json");

function mapItem(i) {
  return {
    launchId: i.launchId,
    tokenName: i.tokenName,
    tokenSymbol: i.tokenSymbol,
    tokenAddress: i.tokenAddress,
    imageUrl: i.imageUrl ?? null,
    createdAt: i.createdAt,
    launcher: {
      name: i.launcher?.name ?? null,
      handle: i.launcher?.handle ?? null,
      image: i.launcher?.image ?? null,
      verified: !!i.launcher?.verified,
      operatorAddress: i.launcher?.operatorAddress ?? null,
      profileUrl: i.launcher?.profileUrl ?? null,
    },
    feeRecipient: i.feeRecipient?.value ?? null,
    dexscreenerUrl: i.public?.dexscreenerUrl ?? null,
    launchUrl: i.public?.launchUrl ?? null,
    basescanUrl: i.public?.basescanUrl ?? null,
  };
}

async function fetchAll() {
  const first = await fetch(`${BASE}?limit=${PAGE}&offset=0`, { headers: { accept: "application/json" } });
  if (!first.ok) throw new Error(`HTTP ${first.status}`);
  const head = await first.json();
  const total = head.total ?? (head.items || []).length;
  let items = [...(head.items || [])];
  for (let off = PAGE; off < total; off += PAGE) {
    const res = await fetch(`${BASE}?limit=${PAGE}&offset=${off}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${off}`);
    const json = await res.json();
    items = items.concat(json.items || []);
  }
  return { total, items };
}

try {
  const { total, items: raw } = await fetchAll();
  const items = raw.filter((i) => i.tokenAddress).map(mapItem);
  if (!items.length) throw new Error("no launches returned");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), total, count: items.length, items }, null, 2)
  );
  console.log(`[gen-launches] wrote ${items.length}/${total} launches -> ${OUT}`);
} catch (err) {
  if (fs.existsSync(OUT)) {
    console.warn(`[gen-launches] fetch failed (${err.message}); keeping existing snapshot.`);
  } else {
    console.error(`[gen-launches] fetch failed (${err.message}) and no existing snapshot; writing empty.`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: 0, count: 0, items: [] }, null, 2));
  }
}
