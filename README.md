# Vetro Arbitrage Bot

Flashloan-funded keeper bot that arbitrages between a [Vetro Gateway](https://vetro.finance) and DEX prices for a **pegged token** on Ethereum mainnet. One binary, two products selectable by env var:

| `PRODUCT` | Pegged token | Underlyings | Peg target |
| --------- | ------------ | ----------- | ---------- |
| `VUSD`    | VUSD         | USDC, USDT  | $1 USD     |
| `VETBTC`  | vetBTC       | WBTC, cbBTC, hemiBTC | 1 BTC |

**Goal:** keep the pegged token on-peg on DEXes and earn profit.

## How It Works

| DEX Price       | Direction      | Flow                                                                                                            |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| pegged > peg    | `mintAndSell`  | Flash underlying → mint pegged via Gateway → sell pegged on DEX → repay flash → split profit                    |
| pegged < peg    | `buyAndRedeem` | Flash underlying → buy cheap pegged on DEX → redeem at Gateway → repay flash → split profit                     |

- **Zero capital** — funded by Morpho flashloans (0 bps fee)
- **Profit split** — configurable keeper share (bps), remainder to treasury
- **Off-chain keeper** — polls prices, simulates via `staticCall`, executes when profitable
- **Multi-product** — same binary runs VUSD or vetBTC by setting `PRODUCT` in `.env`

## Quick Start (DevOps)

```bash
# 1. Install
forge install
npm install

# 2. Configure (minimum)
cp .env.example .env
# Edit .env — at minimum set:
#   ETHEREUM_RPC_URL=<rpc>
#   PRODUCT=VUSD                  (or VETBTC)
# For live mode also set PRIVATE_KEY. Leave it unset for dry-run.

# 3. Run (development)
npm run dev

# 3b. Run (production)
npm run build && npm start
```

If `PRIVATE_KEY` is empty, the bot runs in **dry-run mode**: polls, logs, but never submits a tx. The startup banner shows `Mode: DRY-RUN`.

## Running both products

Each product runs as a **separate process** with its own `.env`. Recommended pattern:

```bash
# Two env files
cp .env.example .env.vusd
cp .env.example .env.vetbtc
# Edit each one and set PRODUCT=VUSD / PRODUCT=VETBTC

# Process A (VUSD)
node --env-file=.env.vusd dist/index.js
# Process B (vetBTC)
node --env-file=.env.vetbtc dist/index.js
```

Or under systemd/pm2 — see "Process Supervision" below. Independent processes give you independent crashes, independent restarts, and per-product log streams for free.

## Per-product env files (`.env.vusd` / `.env.vetbtc`) — DevOps prep

Each product runs from **its own env file**. `docker-compose.yml` expects exactly two files in the repo root: `.env.vusd` (loaded by the `vusd` service) and `.env.vetbtc` (loaded by the `vetbtc` service). Create them before `docker compose up`.

> All product addresses, Curve routes and tuning defaults are committed in `src/products.ts` — operators only set the few values below. **Never commit these env files** (`.env*` is git-ignored).

### DevOps checklist (do this for each product)

1. **RPC** — provision an Ethereum **mainnet** JSON-RPC URL (Alchemy / Infura / QuickNode).
2. **Aggregator keys** — get a [1inch](https://portal.1inch.dev/) key and a [0x/Matcha](https://dashboard.0x.org/) key. LiFi is optional. The **same keys can be reused for both products**.
3. **Keeper wallet** — generate a **separate** wallet per product (don't share one key across VUSD and vetBTC). Fund each with ETH for gas. See "Keeper Wallet Setup" below. Store the private key as hex **without the `0x` prefix**.
4. **Start in dry-run first** — leave `PRIVATE_KEY` empty, confirm the startup banner shows `Mode: DRY-RUN` and prices stream cleanly, then add the key and restart for live mode.
5. **Secrets handling** — inject these files via your secrets manager / CI secret store (Docker secrets, SOPS, Vault, GH Actions secrets). Never bake them into the image — `.dockerignore` already excludes `.env*` from the build context.

### `.env.vusd`

```bash
# ── VUSD keeper bot ───────────────────────────────────────────────
PRODUCT=VUSD                                          # selects the VUSD product
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Keeper wallet — hex, NO 0x prefix. Leave EMPTY for dry-run (no txs).
PRIVATE_KEY=

# DEX aggregator keys (get 1inch + 0x before going live; LiFi optional)
ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY
LIFI_API_KEY=

# Tuning — values in USDC (VUSD's underlying base asset). All optional;
# defaults come from src/products.ts.
MIN_PROFIT_BASE=20                                    # 20 USDC, well above gas
ESTIMATED_GAS_COST_BASE=15
MAX_GAS_PRICE_GWEI=40
SLIPPAGE_BPS=50
POLL_INTERVAL_MS=5000

# Optional — override the deployed arbitrage contract from products.ts
# ARBITRAGE_ADDRESS=0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a
```

### `.env.vetbtc`

```bash
# ── vetBTC keeper bot ─────────────────────────────────────────────
PRODUCT=VETBTC                                        # selects the vetBTC product
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Keeper wallet — hex, NO 0x prefix. Use a DIFFERENT wallet than VUSD.
# Leave EMPTY for dry-run (no txs).
PRIVATE_KEY=

# DEX aggregator keys (same keys as VUSD are fine)
ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY

# Tuning — values in WBTC (vetBTC's underlying base asset). The vetBTC/WBTC
# pool is shallow (~$1k TVL) — keep sizes small until liquidity grows.
MIN_PROFIT_BASE=0.0002                                # ~$18 at BTC=$90k
ESTIMATED_GAS_COST_BASE=0.0001                        # ~$9
MAX_FLASH_AMOUNT=0.5                                  # 0.5 WBTC cap
MAX_GAS_PRICE_GWEI=40
SLIPPAGE_BPS=50
POLL_INTERVAL_MS=5000

# Optional — override the deployed arbitrage contract from products.ts
# ARBITRAGE_ADDRESS=0xB174B2C57AFD9Be660F4c00DF568Fe4c34401aEE
```

Then launch both with Docker:

```bash
docker compose up -d --build      # starts vusd + vetbtc containers
docker compose logs -f vetbtc     # tail one product
```

## Prerequisites

- [Foundry](https://getfoundry.sh/) (`forge`, `anvil`, `cast`) — for tests and deployment
- Node.js >= 20 (for `--env-file`; >= 18 if using `dotenv`)
- Ethereum RPC URL (Alchemy, Infura, QuickNode, …)

## Project Structure

```
contracts/             Solidity contracts (Foundry)
  VetroArbitrage.sol   Core arbitrage contract (product-agnostic — same code for VUSD and vetBTC)
  interfaces/          Gateway + Morpho interfaces
script/Deploy.s.sol    Foundry deployment script
test/                  Solidity unit + mainnet fork tests
test/e2e/              TypeScript E2E tests (Anvil + Vitest + mocks)
scripts/               Operations helpers
  test_arb_fork.sh     Spins up an Anvil mainnet fork with a price imbalance
  calc_arb_thresholds.sh   Sweeps how much external swap volume makes each flash tier profitable
src/                   TypeScript keeper bot
  index.ts             Entry point
  keeper.ts            Main poll loop
  priceMonitor.ts      Multi-source DEX price discovery (quote-all, pick-best)
  profitCalculator.ts  Opportunity evaluation, flash-amount sizing
  swapBuilder.ts       Builds SwapParams for the chosen DEX source
  executor.ts          staticCall simulation + tx submission (or skip in dry-run)
  aggregators.ts       1inch / 0x / LiFi adapters
  dexQuoter.ts         On-chain Curve Router multi-hop quoter (1–5 hops)
  products.ts          Product registry — VUSD, VETBTC configs (addresses, routes, defaults)
  config.ts            Env loader — selects product, applies overrides
  constants.ts         Global infra addresses (Morpho, Curve Router)
  types.ts             Shared types
Dockerfile             Multi-stage image — one image runs either product
docker-compose.yml     Runs VUSD + VETBTC as two containers
.dockerignore          Build-context excludes (keeps secrets out of layers)
```

## Product Catalogue (`src/products.ts`)

All product-specific addresses, Curve routes, and defaults live in `src/products.ts` — committed to git. Operators do **not** need to put these in `.env` unless overriding.

### VUSD

| Component         | Address                                      |
| ----------------- | -------------------------------------------- |
| Pegged (VUSD)     | `0xCa83DDE9c22254f58e771bE5E157773212AcBAc3` |
| Gateway           | `0xDaD503f8B9d42bb7af3AfC588358D30163e4416F` |
| Arbitrage contract | `0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a` |
| Treasury          | `0xC8317A10385BE07901A4c9ee3d06E1D83AE378c9` |
| Underlying — USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (6 dec) |
| Underlying — USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` (6 dec) |

Defaults: `MIN_PROFIT_BASE=5` (USDC), `ESTIMATED_GAS_COST_BASE=5`, `MAX_FLASH_AMOUNT=1,000,000`.

### VETBTC

| Component             | Address                                      |
| --------------------- | -------------------------------------------- |
| Pegged (vetBTC)       | `0xf196C68233464A16CFDa319a47c21f4cECa62001` |
| Gateway               | `0xCBA2Ffa0AC52d7871a4221a871793Eb788013faB` |
| Arbitrage contract    | `0xB174B2C57AFD9Be660F4c00DF568Fe4c34401aEE` |
| Treasury              | `0xd25a7b0b817fD816d0995eC67fb70e75EE65Bd7F` |
| Underlying — WBTC     | `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` (8 dec) |
| Underlying — cbBTC    | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (8 dec) |
| Underlying — hemiBTC  | `0x06ea695B91700071B161A434fED42D1DcbAD9f00` (8 dec) |

Defaults: `MIN_PROFIT_BASE=0.0001` (~$9 at $90k/BTC), `ESTIMATED_GAS_COST_BASE=0.00006`, `MAX_FLASH_AMOUNT=0.5` (WBTC).

**Curve routing:**
- vetBTC/WBTC pool (`0xf2e47b9bcb26463a12b1409be06fdaa1c308aa65`) is currently the only vetBTC venue. TVL is small — flash sizes in `src/products.ts` are intentionally tiny.
- cbBTC and hemiBTC route through WBTC via the 3-coin BTC pool. When vetBTC/cbBTC or vetBTC/hemiBTC pools ship, collapse the relevant underlying's route in `src/products.ts` to a 1-hop direct route.

**Pre-launch TODO for VETBTC:**
1. Deploy `VetroArbitrage` for VETBTC: `PRODUCT=VETBTC forge script script/Deploy.s.sol --broadcast --verify` → put the deployed address in `ARBITRAGE_ADDRESS` env var **or** update `src/products.ts`.
2. Vetro admin: `addToInstantRedeemWhitelist` for that address on the VetBTC Gateway.

## Keeper Wallet Setup (per product)

**One keeper wallet per product.** Reusing one wallet across both products mixes the gas-accounting and concentrates blast radius.

### 1. Generate a fresh wallet

```bash
cast wallet new
# Address:      0xABC…
# Private key:  0xdef…    (paste into .env WITHOUT the 0x prefix)
```

### 2. Fund with ETH for gas

Each arb tx costs ~400k–600k gas; at 30 gwei + ETH=$3000 that's ~$45/tx.

| Environment | Funding   | Runway   |
| ----------- | --------- | -------- |
| Staging     | `0.05 ETH`| ~30 txs  |
| Production  | `0.5 ETH` | ~300 txs |

### 3. Whitelisting — currently NOT required (VUSD)

The VUSD `VetroArbitrage` contract is currently deployed with `keeperRestrictionEnabled = false`, so **any wallet can call** entry points. Verify before launch:

```bash
cast call $ARBITRAGE_ADDRESS "keeperRestrictionEnabled()(bool)" --rpc-url $ETHEREUM_RPC_URL
# Expect: false  (no whitelisting needed)
```

For vetBTC the same default will apply once the contract is deployed. If the owner ever flips restriction back on, you'll see `[Execute] Failed: NotKeeper` and the wallet must be added by the owner:

```bash
cast send $ARBITRAGE_ADDRESS "addKeeper(address)" $KEEPER_ADDRESS \
  --private-key $OWNER_PRIVATE_KEY --rpc-url $ETHEREUM_RPC_URL
```

### 4. Test before going live

Always dry-run first (`PRIVATE_KEY` unset) to validate against the actual chain. When ready, set `PRIVATE_KEY` and restart.

## DEX Aggregator API Keys

The bot quotes all enabled sources **in parallel** and picks the best price. **Get 1inch and Matcha (0x) keys before launch** — LiFi is optional.

| Source            | Status        | Sign-up                                    | Free tier? |
| ----------------- | ------------- | ------------------------------------------ | ---------- |
| **1inch**         | **Recommended** | https://portal.1inch.dev/                | Yes — 1 RPS |
| **Matcha (0x)**   | **Recommended** | https://dashboard.0x.org/                | Yes — monthly cap |
| LiFi              | Optional      | Discord-request                            | Public endpoint works without key (rate-limited) |

Without any aggregator keys the bot falls back to the on-chain Curve Router quoter only — single route per underlying, no cross-DEX comparison.

## Environment Variables (.env)

### Required

| Variable           | Description                                  |
| ------------------ | -------------------------------------------- |
| `ETHEREUM_RPC_URL` | JSON-RPC endpoint                            |
| `PRODUCT`          | `VUSD` or `VETBTC` — selects which product to run |

### Wallet (optional — controls live vs dry-run)

| Variable      | Description |
| ------------- | ----------- |
| `PRIVATE_KEY` | Keeper wallet hex (no `0x` prefix). **Omit / leave empty for dry-run mode.** |

### Address override

| Variable             | Description |
| -------------------- | ----------- |
| `ARBITRAGE_ADDRESS`  | Optional override of the arbitrage contract address from `src/products.ts`. Both VUSD and VETBTC contracts are deployed, so the committed defaults work out of the box — only set this to point at a different deployment. |

### Bot tuning (all optional)

Defaults come from the selected product in `src/products.ts`. Values are denominated in the product's underlying base asset (USDC for VUSD, WBTC for VETBTC).

| Variable                   | Default (VUSD / VETBTC)  | Description |
| -------------------------- | ------------------------ | ----------- |
| `MIN_PROFIT_BASE`          | `5` / `0.0001`           | Minimum estimated profit (in base asset) to execute |
| `ESTIMATED_GAS_COST_BASE`  | `5` / `0.00006`          | Gas-cost assumption subtracted from profit estimate |
| `MAX_FLASH_AMOUNT`         | `1000000` / `0.5`        | Cap on flash size (human units of base asset) |
| `FLASH_AMOUNT_TIERS`       | see `products.ts`        | JSON: `[[deviationBps, amount], …]`, first match wins |
| `POLL_INTERVAL_MS`         | `5000`                   | Price poll interval (ms) |
| `MAX_GAS_PRICE_GWEI`       | `50`                     | Skip if gas price exceeds this |
| `SLIPPAGE_BPS`             | `50`                     | DEX slippage tolerance (50 = 0.5%) |

### DEX price sources

| Variable             | Default | Description |
| -------------------- | ------- | ----------- |
| `ONEINCH_API_KEY`    | —       | **Recommended.** 1inch API key (portal.1inch.dev) |
| `ZEROX_API_KEY`      | —       | **Recommended.** Matcha/0x API key (dashboard.0x.org) |
| `LIFI_API_KEY`       | —       | Optional. Public endpoint works without |
| `ENABLE_ONEINCH`     | `true`  | Toggle 1inch |
| `ENABLE_ZEROX`       | `true`  | Toggle 0x |
| `ENABLE_LIFI`        | `true`  | Toggle LiFi |
| `ENABLE_CURVE_ROUTER`| `true`  | Toggle on-chain Curve Router quoter |

### Deployment-only (for `forge script script/Deploy.s.sol`)

| Variable             | Description |
| -------------------- | ----------- |
| `KEEPER_ADDRESS`     | Initial keeper address to whitelist at deploy time |
| `OWNER_ADDRESS`      | Contract owner (admin) address |
| `KEEPER_SHARE_BPS`   | Initial keeper profit share in bps (default 0, max 5000) |
| `ETHERSCAN_API_KEY`  | For `--verify` |

## Recommended configuration by scenario

Three starting profiles. Pick one, copy into `.env`, then tune.

### A. Dry-run / observation (no risk)

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRODUCT=VUSD
# PRIVATE_KEY=                          # leave unset → DRY-RUN
ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY
POLL_INTERVAL_MS=10000
```

### B. Production — VUSD live (early launch)

```bash
ETHEREUM_RPC_URL=...
PRODUCT=VUSD
PRIVATE_KEY=<keeper-wallet-hex>

ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY
LIFI_API_KEY=YOUR_LIFI_KEY              # optional

MIN_PROFIT_BASE=20                      # 20 USDC, well above gas
ESTIMATED_GAS_COST_BASE=15
MAX_GAS_PRICE_GWEI=40
SLIPPAGE_BPS=50
```

### C. Production — vetBTC live

```bash
ETHEREUM_RPC_URL=...
PRODUCT=VETBTC
PRIVATE_KEY=<keeper-wallet-hex>
ARBITRAGE_ADDRESS=0x...                 # vetBTC arb contract address

ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY

MIN_PROFIT_BASE=0.0002                  # ~$18 at BTC=$90k
ESTIMATED_GAS_COST_BASE=0.0001          # ~$9
MAX_GAS_PRICE_GWEI=40
SLIPPAGE_BPS=50
```

### Important: `MIN_PROFIT_BASE` vs real gas cost

The on-chain `minProfit_` guard is denominated in **underlying base asset**, not net of gas (gas is paid in ETH separately). Setting it too low means the bot can execute trades that are net-negative after gas.

```
MIN_PROFIT_BASE  ≥  expected_gas_cost_in_base + safety_buffer
```

Estimate `expected_gas_cost_in_base`:

- Each arb tx uses ~400k–600k gas (mint + swap, or swap + redeem)
- At ETH=$3,000 / 30 gwei / 500k gas → ~$45 per tx
- For VUSD: that's ~45 USDC → set `MIN_PROFIT_BASE=60`
- For VETBTC: that's ~0.0005 BTC → set `MIN_PROFIT_BASE=0.0007`

`ESTIMATED_GAS_COST_BASE` affects only the off-chain "is this profitable?" estimate; `MIN_PROFIT_BASE` is what the contract enforces. Keep both aligned with real gas conditions; revisit weekly.

## DEX Price Sources

The bot queries all enabled sources in parallel and picks the best:

- **Sell direction** (pegged → underlying): highest output wins
- **Buy direction** (underlying → pegged): lowest cost wins

| Source       | Type                | API key |
| ------------ | ------------------- | ------- |
| 1inch        | Aggregator API      | yes     |
| 0x / Matcha  | Aggregator API      | yes     |
| LiFi         | Aggregator API      | optional |
| Curve Router | On-chain multi-hop  | no      |

Curve Router routes (1–5 hops) live in `src/products.ts` per product. New pools — patch the product file, no env change.

## Dry-run Mode

Leave `PRIVATE_KEY` unset and run:

```bash
npm run dev
```

Startup banner shows:

```
Mode        : DRY-RUN (no PRIVATE_KEY — txs will be skipped)
```

Bot does everything except `executor.execute()`. Use this to validate `.env`, observe spreads, and test new RPC endpoints without risk.

## Running the Bot

```bash
npm run dev      # tsx, no build step (development)
npm run build    # tsc compile
npm start        # node dist/index.js (production)
```

### Process supervision (production)

Recommended: run each product under a process manager that auto-restarts on crash. systemd unit template:

```ini
# /etc/systemd/system/arb-vusd.service
[Unit]
Description=Vetro VUSD Arbitrage Keeper
After=network-online.target

[Service]
ExecStart=/usr/bin/node --env-file=/srv/arb/.env.vusd /srv/arb/dist/index.js
WorkingDirectory=/srv/arb
Restart=on-failure
RestartSec=5
User=arb

[Install]
WantedBy=multi-user.target
```

Duplicate as `arb-vetbtc.service` with `--env-file=/srv/arb/.env.vetbtc`.

## Docker (DevOps)

The repo ships a `Dockerfile` and `docker-compose.yml`. **One image runs both
products** — `PRODUCT` is selected at runtime via the env file, never baked in.
No secrets are copied into the image: all config arrives as runtime env vars.

### Prerequisites

- Docker Engine 20.10+ (with the `docker compose` plugin)
- `.env.vusd` and/or `.env.vetbtc` present in the repo root (see "Environment
  Variables" above). These are **not** copied into the image — they are read at
  `docker run` time.

### Option A — docker compose (runs both products)

```bash
# Build the image and start both keepers as background containers
docker compose up -d --build

# Tail logs (one product, or omit the name for both)
docker compose logs -f vetbtc
docker compose logs -f vusd

# Restart / stop
docker compose restart vetbtc
docker compose down
```

Each service has `restart: unless-stopped`, so a crashed keeper auto-restarts
and survives host reboots. To run only one product:

```bash
docker compose up -d --build vetbtc
```

### Option B — plain docker (single product)

```bash
# Build once
docker build -t vetro-arb-bot:latest .

# Run VETBTC
docker run -d --name arb-vetbtc \
  --env-file .env.vetbtc \
  --restart unless-stopped \
  vetro-arb-bot:latest

# Run VUSD
docker run -d --name arb-vusd \
  --env-file .env.vusd \
  --restart unless-stopped \
  vetro-arb-bot:latest

# Logs
docker logs -f arb-vetbtc
```

### Dry-run vs live in Docker

Same rule as bare-metal: if `PRIVATE_KEY` is absent from the env file the
container runs in **dry-run** mode. Confirm via the startup banner:

```bash
docker compose logs vetbtc | grep Mode
#   Mode        : DRY-RUN (no PRIVATE_KEY — txs will be skipped)
```

Go live by adding `PRIVATE_KEY` to the env file and recreating the container
(`docker compose up -d vetbtc` / `docker run` again).

### Notes for operators

- **Secrets**: `.env*` files are excluded by `.dockerignore`, so private keys
  never land in an image layer. Keep the env files readable only by the deploy
  user (`chmod 600 .env.vetbtc`).
- **Updating the bot**: after pulling new code, `docker compose up -d --build`
  rebuilds and recreates containers with zero extra steps.
- **Signal handling**: `init: true` (compose) / Docker's default init forwards
  `SIGTERM` so the keeper's graceful `keeper.stop()` runs on `docker stop`.
- **Image size**: multi-stage build ships only `dist/` + production deps
  (`ethers`, `dotenv`) — no `tsc`, no Foundry artifacts.

### Example startup output (VUSD live mode)

```
[Keeper] Price sources: 0x → curve_router → default(1.0) | Flash loan: Morpho (0bps fee)
═══════════════════════════════════════════════════
  Vetro USD Arbitrage Keeper (VUSD)
═══════════════════════════════════════════════════
  Product     : VUSD
  Pegged      : VUSD (0xCa83DDE9c22254f58e771bE5E157773212AcBAc3)
  Arb contract: 0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a
  Underlyings : USDC, USDT
  Flash loan  : Morpho (0bps fee)
  Mode        : LIVE
  Min profit  : 20 USDC
  Poll        : 5s
  Flash tiers : >500bps→2000USDC, >200bps→1000USDC, >50bps→500USDC, >0bps→500USDC
═══════════════════════════════════════════════════
```

### Example per-tick output

```
[USDC] DEX sell quotes: lifi=0.995645, curve_router=0.997243 → using curve_router (0.997243)
[USDC] DEX buy  quotes: lifi=1.008339, curve_router=1.005829 → using curve_router (1.005829)
[12:08:06] [USDC] sell=0.9972 buy=1.0058 (BELOW peg, 28bps) | via curve_router/curve_router | MINT_AND_SELL spread=-28bps | flash=500USDC | est=-6.38 USDC (min 20 USDC) | fees: mint=0bps redeem=0bps
```

## Monitoring / Alerting

| Signal                                              | Meaning / Action |
| --------------------------------------------------- | ---------------- |
| `Tick error:` repeating                             | RPC or unexpected error — restart, investigate |
| `All DEX <sell|buy> price sources failed`           | Every source failed. Check API keys, Curve routes, pool liquidity |
| `Gas price too high`                                | Normal during congestion; raise `MAX_GAS_PRICE_GWEI` if needed |
| `SKIP BUY_AND_REDEEM: Gateway has 0 X reserves`     | Expected when Gateway can't satisfy redeems |
| `SKIP MINT_AND_SELL: Gateway mint cap reached`      | Expected when Gateway is full |
| `[Simulation] Reverted: …`                          | staticCall failed. See troubleshooting below. |
| `ARB EXECUTED!` log line                            | Successful arb. Cross-check tx hash on Etherscan. |

On-chain event for execution monitoring:

```solidity
event ArbitrageExecuted(
    ArbDirection indexed direction,
    address indexed stablecoin,
    uint256 flashAmount,
    int256 profit,
    uint256 keeperProfit,
    uint256 treasuryProfit
);
```

## Build & Test (Contracts)

```bash
forge build

# Unit tests (no RPC needed)
forge test --mc VetroArbitrageTest -vv

# Mainnet fork tests (requires RPC)
ETHEREUM_RPC_URL=<rpc> forge test --mc VetroArbitrageForkTest -vvv
```

## E2E Tests (Off-Chain Pipeline)

```bash
npm run test:e2e
```

Starts Anvil, deploys mocks, runs MINT_AND_SELL / BUY_AND_REDEEM / at-peg-skip / below-threshold-skip, shuts down.

## Mainnet Fork Smoke Test

```bash
# Terminal 1
./scripts/test_arb_fork.sh

# Terminal 2
ETHEREUM_RPC_URL=http://127.0.0.1:8545 \
PRODUCT=VUSD \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
npm run dev
```

(The hex above is Anvil's first dev key.)

## Threshold Sweep

```bash
./scripts/calc_arb_thresholds.sh
```

Sweeps how much external swap volume makes each flash tier profitable. Pure analysis, no bot. Useful for tuning `FLASH_AMOUNT_TIERS` and `MIN_PROFIT_BASE`.

## Deploy Contract

`VetroArbitrage` is product-agnostic — the same source compiles for both VUSD and vetBTC. The deploy script accepts a `PRODUCT` env var to pick the right Gateway / Treasury defaults.

```bash
export ETHEREUM_RPC_URL=<rpc>
export PRIVATE_KEY=<deployer-key>
export KEEPER_ADDRESS=<initial-keeper>
export OWNER_ADDRESS=<admin>
export KEEPER_SHARE_BPS=1000          # optional, defaults to 0
export ETHERSCAN_API_KEY=<key>        # for --verify

# Deploy for VUSD (default)
PRODUCT=VUSD forge script script/Deploy.s.sol --rpc-url $ETHEREUM_RPC_URL --broadcast --verify

# Deploy for vetBTC
PRODUCT=VETBTC forge script script/Deploy.s.sol --rpc-url $ETHEREUM_RPC_URL --broadcast --verify
```

Optional: `TREASURY_ADDRESS=0x…` overrides the default treasury for either product.

After deployment:

1. Note the deployed `VetroArbitrage` address from script output.
2. Update `src/products.ts` (set `arbitrageAddress` for the product) **or** add `ARBITRAGE_ADDRESS=0x…` to that product's `.env`.
3. Vetro admin: whitelist the new address for instant redeem on the appropriate Gateway.

## Contract Admin Functions

| Function                          | Access  | Description |
| --------------------------------- | ------- | ----------- |
| `addKeeper(address)`              | Owner   | Whitelist a keeper |
| `removeKeeper(address)`           | Owner   | Remove a keeper |
| `setKeeperRestriction(bool)`      | Owner   | Toggle the keeper whitelist (false = public) |
| `setTreasury(address)`            | Owner   | Change profit recipient |
| `setKeeperShareBps(uint256)`      | Owner   | Change keeper profit share (max 5000 = 50%) |
| `setGateway(address)`             | Owner   | Update the Gateway address |
| `setMorpho(address)`              | Owner   | Update the Morpho flash loan pool address |
| `rescueTokens(address)`           | Keeper  | Sweep a stuck token to treasury |
| `emergencyWithdraw(token,to,amt)` | Owner   | Withdraw any token to any address |

## Troubleshooting

| Symptom                                                  | Cause / Fix |
| -------------------------------------------------------- | ----------- |
| `Missing required environment variable: ETHEREUM_RPC_URL` | `.env` not loaded or var not set |
| `PRODUCT env var is required. Set PRODUCT=VUSD or PRODUCT=VETBTC.` | Add `PRODUCT=VUSD` (or `VETBTC`) to `.env` |
| `No arbitrage contract address configured for product VETBTC.` | Deploy `VetroArbitrage` with `PRODUCT=VETBTC`, then set `ARBITRAGE_ADDRESS` in `.env` or update `src/products.ts` |
| `Mode: DRY-RUN` when you expected live | `PRIVATE_KEY` not set or empty |
| Every tick logs `No DEX quote available` | All aggregators returned no route AND Curve Router quote reverted. Verify API keys and pool liquidity |
| `[Simulation] Reverted: …` | staticCall failed before submission. Reasons: keeper not whitelisted (`NotKeeper` — only if restriction is on); minOut too tight (raise `SLIPPAGE_BPS`); Gateway capacity hit between price-fetch and simulation |
| `[Execute] Gas price too high` | Network congestion; raise `MAX_GAS_PRICE_GWEI` or wait |
| `[Execute] Failed: insufficient funds` | Keeper wallet has no ETH — top up gas |
| `[Execute] Failed: NotKeeper` | Wallet behind `PRIVATE_KEY` is not whitelisted AND `keeperRestrictionEnabled=true`. Either flip restriction off, or have owner call `addKeeper` |

## NPM Scripts

| Script             | Command            | Description                          |
| ------------------ | ------------------ | ------------------------------------ |
| `npm run dev`      | `tsx src/index.ts` | Run in dev mode (no build step)      |
| `npm run build`    | `tsc`              | Compile TypeScript                   |
| `npm start`        | `node dist/index.js` | Run compiled bot                   |
| `npm run lint`     | `tsc --noEmit`     | Type-check without emitting          |
| `npm run test:e2e` | `vitest run`       | Run E2E tests                        |
