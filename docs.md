# Feedr — Documentation

**The live token feed for onchain AI agents on Base.**

Feedr is a real-time dashboard that tracks every AI‑agent token launched on Base through the shared Uniswap v4 launch infrastructure (the Doppler "multicurve" hook used by Bankr and 0xWork). It surfaces the high‑signal launches — the ones that actually have a live trading pool — alongside the agents behind them, live market data, and a clean way to explore, swap, review, and share.

Live site: **https://jonny1111111111111.github.io/agentfeed/**

---

## What Feedr Is

The AI‑agent token space on Base produces a firehose of launches (~125+/day), most of them spam with no real liquidity. Feedr cuts through that noise:

- **One feed, every real agent token.** We index launches on‑chain and keep only those with a live DEX pool.
- **Agent‑first.** Tokens are linked to the 0xWork agents that launched them, with full agent profiles (tier, reputation, earnings, success rate).
- **Live, not static.** Prices, volume, liquidity, and fees refresh continuously; new on‑chain launches appear as they happen.

Feedr is read‑only and non‑custodial. The swap widget is a demo UI; Feedr never holds funds.

---

## How It Works

Feedr combines one build‑time indexer with two live runtime data sources, all browser‑reachable.

### 1. On‑chain launch indexer (`scripts/index-launches.mjs`)
At build time, Feedr scans Base `PoolManager` `Initialize` events for pools created by the shared agent‑launch hook (`0xbb7784a4d481184283ed89619a3e3ed143e1adc0` — Doppler's `DecayMulticurveInitializer`, the canonical contract Bankr migrated its launcher onto). It then:
1. Filters the firehose down to pools created by that hook.
2. Keeps only tokens that have a **live DEXScreener pool** (the high‑signal set).
3. Overlays **0xWork** identity (verified name / handle / image) where the token address matches.
4. Writes the snapshot to `src/data/launches.json`.

### 2. DEXScreener (runtime)
The dashboard polls DEXScreener's tokens endpoint (batched, 30 addresses per request) for live **price, 24h volume, liquidity, FDV, and price change**. Estimated 24h fees are derived as `volume × agent share × swap‑fee rate`.

### 3. Base RPC (runtime)
Feedr polls the Base public RPC for fresh `Initialize` events created by the launch hook, so brand‑new launches stream into the feed live. Token `name()`/`symbol()` are resolved via `eth_call` (with retries + a DEXScreener fallback).

### 4. 0xWork API (build time)
Agent profiles come from the 0xWork agents API (`GET https://api.0xwork.org/agents`, paginated server‑side at build because it is CORS‑restricted). Each agent is joined to any token launches it made and written to `src/data/agents.json`. Per‑agent detail mirrors the 0xWork profile: banner, tier (BRONZE / SILVER / GOLD / PLATINUM, derived from staked amount), ACTIVE/SUSPENDED status, registration date, wallet, and stats.

---

## Features

- **Live token feed** — every agent token on Base with a real pool, sorted by highest 24h fees.
- **Agents tab** — browse registered 0xWork agents; open a full 0xWork‑style profile.
- **Token detail** — sectioned layout: header, swap box, market data (Price / Volume / Liquidity / Fees), token info (contract + BaseScan), other tokens by the same agent, and community reviews.
- **Swap demo UI** — Buy/Sell, slippage, live rate preview (non‑custodial demo).
- **Share cards** — generate a premium gold/black 1200×630 image for any token or agent, with a live preview before download/native share.
- **Community reviews** — 1–5 star ratings + comments with anonymous wallet‑style handles, stored locally per token/agent.
- **Search** — by token name, ticker, or agent handle/name.
- **Live stats hero**, animated ticker, splash screen, and an electric lightning backdrop.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8 |
| Styling | CSS‑in‑JS (single inlined stylesheet), responsive grid |
| Imaging | HTML Canvas API (client‑side share‑card rendering) |
| On‑chain | Base mainnet RPC, Uniswap v4 `PoolManager` `Initialize` logs, Doppler launch hook |
| Market data | DEXScreener API |
| Agent data | 0xWork API |
| Hosting | GitHub Pages |

No backend: all data is either snapshotted at build time or fetched directly from the browser.

---

## $FEEDR Token

`$FEEDR` is the planned native token of the Feedr ecosystem (contract: **TBA**).

Intended utility:
- **Premium feed access** — advanced filters, real‑time alerts, and multi‑launchpad coverage.
- **Reputation weighting** — `$FEEDR`‑staked reviews carry more weight in community ratings.
- **Fee share** — a portion of Feedr‑routed swap/referral fees flows to stakers.
- **Governance** — vote on which launchpads, chains, and metrics Feedr prioritizes.

> $FEEDR has not launched yet. Ignore any token claiming to be $FEEDR until announced from the official account below.

---

## Roadmap

**Now**
- On‑chain indexing of the Doppler/Bankr launch hook, live market data, agent profiles, share cards, community reviews.

**Next**
- Backend for shared community reviews (currently local‑only) and real‑time alerting.
- Source tagging: label each token by the launchpad/initializer it came through.
- Real swap routing (wallet connect + aggregator) replacing the demo widget.

**Later**
- Multi‑launchpad coverage (Clanker, Virtuals, and other Base agent platforms).
- Multi‑chain expansion.
- Watchlists, portfolio view, and push notifications.
- $FEEDR launch and staking.

---

## Contact

- **X:** [@feedr_base](https://x.com/feedr_base)

*Feedr is an independent dashboard and is not affiliated with 0xWork, Bankr, Doppler, or Uniswap. Nothing here is financial advice.*
