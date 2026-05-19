# VUSD Arbitrage Bot

Flashloan-funded keeper bot that arbitrages between [Vetro Gateway](https://vetro.finance) mint/redeem and DEX prices for VUSD on Ethereum mainnet.

**Goal:** keep VUSD pegged to $1 on DEXes and earn profit.

## How It Works

| DEX Price | Direction      | Flow                                                                                       |
| --------- | -------------- | ------------------------------------------------------------------------------------------ |
| VUSD > $1 | `mintAndSell`  | Flash USDC/USDT → mint VUSD via Gateway → sell VUSD on DEX → repay flash → split profit    |
| VUSD < $1 | `buyAndRedeem` | Flash USDC/USDT → buy cheap VUSD on DEX → redeem at Gateway → repay flash → split profit   |

- **Zero capital** — funded by Morpho flashloans (0 bps fee)
- **Profit split** — configurable keeper share (bps), remainder to treasury
- **Off-chain keeper** — polls prices, simulates via `staticCall`, executes when profitable

## Quick Start (DevOps)

```bash
# 1. Install
forge install
npm install

# 2. Configure
cp .env.example .env
# Edit .env — at minimum set ETHEREUM_RPC_URL
# For production, also set PRIVATE_KEY. Leave it unset for dry-run mode.

# 3. Run (development)
npm run dev

# 3b. Run (production)
npm run build && npm start
```

If you only set `ETHEREUM_RPC_URL` and leave `PRIVATE_KEY` empty, the bot runs in **dry-run mode**: it polls prices, evaluates opportunities, logs everything, but never submits a tx. The startup banner will show `Mode: DRY-RUN`.

## Prerequisites

- [Foundry](https://getfoundry.sh/) (`forge`, `anvil`, `cast`) — for tests and deployment
- Node.js >= 18
- Ethereum RPC URL (Alchemy, Infura, QuickNode, …)

## Project Structure

```
contracts/             Solidity contracts (Foundry)
  VUSDArbitrage.sol    Core arbitrage contract (Morpho callback)
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
  dexQuoter.ts         On-chain Curve Router multi-hop quoter
  config.ts            Env config loader
  constants.ts         Hardcoded mainnet addresses
  types.ts             Shared types
```

## Hardcoded Addresses

Set in `src/constants.ts` — do not override unless redeploying. DevOps does **not** need to put these in `.env`.

| Contract        | Address                                      |
| --------------- | -------------------------------------------- |
| Vetro Gateway   | `0xDaD503f8B9d42bb7af3AfC588358D30163e4416F` |
| VUSD Token      | `0xCa83DDE9c22254f58e771bE5E157773212AcBAc3` |
| VUSDArbitrage   | `0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a` |
| Treasury        | `0xC8317A10385BE07901A4c9ee3d06E1D83AE378c9` |
| USDC            | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDT            | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| crvUSD          | `0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E` |
| Morpho          | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Curve Router    | `0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e` |

If `VUSDArbitrage` is redeployed, override via env: `VUSD_ARBITRAGE_ADDRESS=0x...`. All other addresses are not configurable.

## Keeper Wallet Setup

The bot signs `mintAndSell` / `buyAndRedeem` transactions with a hot wallet. **Use a fresh wallet dedicated to this bot — do not reuse personal or treasury keys.** The wallet holds only ETH for gas; profits go to the contract's treasury (not the keeper wallet) minus the configured keeper share.

### 1. Generate a fresh wallet

Using Foundry (already installed as a prerequisite):

```bash
cast wallet new
# Outputs:
#   Address:     0xABC...
#   Private key: 0xdef...
```

Save the **address** and **private key** somewhere secure (password manager / secrets vault). The bot expects the private key **without** the `0x` prefix in `.env`:

```bash
PRIVATE_KEY=def...                    # no 0x prefix
```

Alternatives: any Ethereum wallet generator works (MetaMask export, ethers.js `Wallet.createRandom()`, hardware wallet, etc.) — just make sure you can extract the raw private key.

### 2. Fund with ETH for gas

Send ETH to the keeper address. Each arb tx costs ~400k–600k gas; at 30 gwei + ETH=$3000 that's ~$45 per tx.

Suggested initial funding:

| Environment | Funding   | Runway (rough)           |
| ----------- | --------- | ------------------------ |
| Staging     | `0.05 ETH`| ~30 txs                  |
| Production  | `0.5 ETH` | ~300 txs                 |

Top up when balance drops below ~2 weeks of expected tx volume. Easy to script with an alert: `web3.eth.getBalance(keeperAddr) < threshold → notify`.

### 3. Whitelisting — currently NOT required

The deployed `VUSDArbitrage` contract has **`keeperRestrictionEnabled = false`**, which means **any wallet can call `mintAndSell` / `buyAndRedeem`**. No whitelisting step is needed for the wallet you just created — once it's funded with ETH, the bot can submit transactions.

Verify current state before launch:

```bash
cast call 0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a \
  "keeperRestrictionEnabled()(bool)" \
  --rpc-url $ETHEREUM_RPC_URL
# Expect: false  (no whitelist needed)
```

If the owner later switches restriction back on (`setKeeperRestriction(true)`), you will see `[Execute] Failed: NotKeeper` errors and the wallet must then be added:

```bash
# Owner-only operation, run once per keeper address:
cast send 0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a \
  "addKeeper(address)" $KEEPER_ADDRESS \
  --private-key $OWNER_PRIVATE_KEY --rpc-url $ETHEREUM_RPC_URL

# Confirm:
cast call 0x1C17CC10ddc5B352f7c6C5dDa33B07769bff310a \
  "isKeeper(address)(bool)" $KEEPER_ADDRESS \
  --rpc-url $ETHEREUM_RPC_URL
# Expect: true
```

Running multiple keepers (redundant regions) is fine in either mode — the contract is reentrancy-guarded, and only one will land each opportunity due to on-chain ordering.

### 4. Test before going live

Always dry-run first (`PRIVATE_KEY` unset) to validate `.env` against the actual chain. When ready, set `PRIVATE_KEY` and restart.

## DEX Aggregator API Keys

The bot quotes prices from multiple sources in parallel and picks the best. Aggregators give wider DEX coverage (Uniswap, Curve, Balancer, etc. across one API call). **Get 1inch and Matcha (0x) keys before launch** — LiFi is optional.

| Source            | Status        | Sign-up                                    | Free tier?            |
| ----------------- | ------------- | ------------------------------------------ | --------------------- |
| **1inch**         | **Recommended** | https://portal.1inch.dev/                | Yes — 1 RPS, plenty for `POLL_INTERVAL_MS=5000` |
| **Matcha (0x)**   | **Recommended** | https://dashboard.0x.org/ (free signup)  | Yes — has monthly request cap |
| LiFi              | Optional      | https://docs.li.fi/ (request key in Discord) | Public endpoint works without key (rate-limited) |

### How to get the keys

**1inch:**

1. Go to https://portal.1inch.dev/ and sign in (Google / GitHub / wallet).
2. Click **"Create new application"** → give it a name (e.g. `vusd-arb-bot`).
3. Enable the **"Swap API"** product on that app.
4. Copy the API key shown. Put it in `.env`:
   ```
   ONEINCH_API_KEY=your-1inch-key-here
   ```

**Matcha / 0x:**

1. Go to https://dashboard.0x.org/ and sign up.
2. Create a new app, name it (e.g. `vusd-arb-bot`).
3. Find the API key in the app settings.
4. Put it in `.env`:
   ```
   ZEROX_API_KEY=your-0x-key-here
   ```

**LiFi (optional):**

The bot's LiFi adapter works without a key, but the public endpoint rate-limits aggressively under load. Skip unless you see frequent `lifi` quote failures in logs. To request a key, join the LiFi Discord (link from their docs site) and ask in the developer channel.

```
LIFI_API_KEY=your-lifi-key-here       # only if you've requested one
```

### What if I don't set any keys?

The bot still runs — it just falls back to the on-chain **Curve Router** quoter for VUSD price discovery. This works once VUSD has Curve liquidity, but:

- Single route, single pool → no cross-DEX comparison
- If Curve Router reverts (no route, illiquid), the bot has nothing else and logs `default(1.0)`

**Strongly recommended to set at least `ONEINCH_API_KEY` and `ZEROX_API_KEY`** before going live.

## Environment Variables (.env)

### Required

| Variable           | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `ETHEREUM_RPC_URL` | JSON-RPC endpoint (Alchemy, Infura, etc.)            |

### Wallet (optional — controls live vs dry-run)

| Variable      | Description                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| `PRIVATE_KEY` | Keeper wallet hex private key (no `0x` prefix). **Omit / leave empty for dry-run mode.** |

When `PRIVATE_KEY` is missing the bot polls + logs but never submits a tx. Useful for staging, observing prices, or smoke-testing config changes safely.

### Contract address override (optional)

| Variable                 | Description                                                                |
| ------------------------ | -------------------------------------------------------------------------- |
| `VUSD_ARBITRAGE_ADDRESS` | Override the deployed `VUSDArbitrage` contract address from `constants.ts` |

### Bot tuning (all optional, sensible defaults)

| Variable                 | Default          | Description                                                          |
| ------------------------ | ---------------- | -------------------------------------------------------------------- |
| `MIN_PROFIT_USD`         | `5`              | Minimum estimated USD profit to execute                              |
| `MAX_FLASH_AMOUNT`       | `1000000000000`  | Max flash loan in token base units (~1M USDC)                        |
| `POLL_INTERVAL_MS`       | `5000`           | Price poll interval (ms)                                             |
| `MAX_GAS_PRICE_GWEI`     | `50`             | Skip execution if gas price > this                                   |
| `SLIPPAGE_BPS`           | `50`             | DEX slippage tolerance (50 = 0.5%)                                   |
| `ESTIMATED_GAS_COST_USD` | `5`              | Assumed gas cost subtracted from profit estimate                     |
| `FLASH_AMOUNT_TIERS`     | see below        | JSON `[[deviationBps, amountUsd], …]` — first match wins (sorted desc)|

Default flash tiers (conservative for low-liquidity launch):

```
[[500, 2000], [200, 1000], [50, 500], [0, 500]]
```

| Deviation     | Flash size | Meaning           |
| ------------- | ---------- | ----------------- |
| > 500 bps (5%) | $2,000     | Large depeg       |
| > 200 bps (2%) | $1,000     | Moderate depeg    |
| > 50  bps (0.5%) | $500     | Small depeg       |
| > 0   bps     | $500       | Minimum trade     |

### Recommended configuration by scenario

Three starting profiles. Pick one, copy into `.env`, then tune over time.

#### A. Dry-run / observation (no key, no risk)

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
# PRIVATE_KEY=     ← leave unset for DRY-RUN mode (bot logs but never submits)

ONEINCH_API_KEY=YOUR_1INCH_KEY        # optional but improves quote coverage
ZEROX_API_KEY=YOUR_0X_KEY             # optional
# LIFI_API_KEY=...                    # optional

POLL_INTERVAL_MS=10000                # 10s — gentle on RPC + APIs
MIN_PROFIT_USD=5                      # logs more "ACTIONABLE" candidates
```

#### B. Production — early launch / low VUSD liquidity

Use until VUSD pool TVL stabilizes. Conservative sizing, generous safety margins.

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=<keeper-wallet-hex>       # MUST be funded with ETH for gas

# Coverage
ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY
LIFI_API_KEY=YOUR_LIFI_KEY            # recommended — public endpoint rate-limits

# Sizing (small, since pool is shallow)
FLASH_AMOUNT_TIERS=[[500,1000],[200,500],[50,200],[0,100]]
MAX_FLASH_AMOUNT=2000000000           # 2,000 USDC cap

# Safety
MIN_PROFIT_USD=20                     # well above realistic gas — see note below
ESTIMATED_GAS_COST_USD=15             # be honest, see note below
MAX_GAS_PRICE_GWEI=40                 # skip when network is congested
SLIPPAGE_BPS=50                       # 0.5% — typical for stableswap

# Timing
POLL_INTERVAL_MS=5000                 # 5s — balanced
```

#### C. Production — mature pool / deep liquidity

After VUSD pool grows and arb opportunities are larger. Faster polling, bigger trades.

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=<keeper-wallet-hex>

ONEINCH_API_KEY=YOUR_1INCH_KEY
ZEROX_API_KEY=YOUR_0X_KEY
LIFI_API_KEY=YOUR_LIFI_KEY

FLASH_AMOUNT_TIERS=[[500,50000],[200,20000],[50,5000],[0,1000]]
MAX_FLASH_AMOUNT=100000000000         # 100,000 USDC cap

MIN_PROFIT_USD=30
ESTIMATED_GAS_COST_USD=20
MAX_GAS_PRICE_GWEI=80                 # more aggressive, willing to pay for speed
SLIPPAGE_BPS=30                       # tighter, expects deeper liquidity

POLL_INTERVAL_MS=3000                 # 3s — faster reactions
```

#### Important: `MIN_PROFIT_USD` vs real gas cost

The on-chain `minProfit_` guard in the contract is denominated in **stablecoin**, not net of gas (gas is paid in ETH, separate). So if `MIN_PROFIT_USD=5` and your actual tx gas is `$30`, the bot can execute a `$5` stablecoin-profit trade and you'll lose `$25` net.

Rule of thumb:

```
MIN_PROFIT_USD  ≥  expected_gas_usd + safety_buffer (5–10 USD)
```

Estimate `expected_gas_usd`:

- Arb tx typically uses **~400k–600k gas** (mint + swap, or swap + redeem)
- Look up current ETH price and gas price (e.g. https://etherscan.io/gastracker)
- `gas_cost_eth = gas_used × gas_price`
- `gas_usd = gas_cost_eth × eth_price`

At ETH=$3,000, 30 gwei, 500k gas → ~$45 per tx. Setting `MIN_PROFIT_USD=20` here would be **unsafe**. Bump to `MIN_PROFIT_USD=60`, `ESTIMATED_GAS_COST_USD=45`.

`ESTIMATED_GAS_COST_USD` only affects the **off-chain** "is this profitable?" estimate. It does not affect what the contract enforces. Keep both this and `MIN_PROFIT_USD` aligned with real gas conditions; revisit weekly.

### DEX price sources

| Variable             | Default | Description                                                |
| -------------------- | ------- | ---------------------------------------------------------- |
| `ONEINCH_API_KEY`    | —       | **Recommended.** 1inch API key (https://portal.1inch.dev/) |
| `ZEROX_API_KEY`      | —       | **Recommended.** Matcha/0x API key (https://dashboard.0x.org/) |
| `LIFI_API_KEY`       | —       | Optional. LiFi works without a key but is rate-limited.    |
| `ENABLE_ONEINCH`     | `true`  | Toggle 1inch                                               |
| `ENABLE_ZEROX`       | `true`  | Toggle 0x                                                  |
| `ENABLE_LIFI`        | `true`  | Toggle LiFi                                                |
| `ENABLE_CURVE_ROUTER`| `true`  | Toggle on-chain Curve Router quoter                        |

Set any `ENABLE_*=false` to disable a source. An aggregator only activates if its API key is set; LiFi works without a key but rate-limits aggressively.

### Curve Router routes (one per stablecoin)

These are the on-chain fallback routes when aggregator APIs return no quote. **Sane defaults are pre-set in `.env.example`** — operators should generally not need to change these.

| Variable                   | Format                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `CURVE_ROUTER_ROUTE_USDC`  | `hop1|hop2` where each hop is `pool:i:j:swapType:poolType:nCoins`. Encodes USDC → crvUSD → VUSD.        |
| `CURVE_ROUTER_ROUTE_USDT`  | Same shape. Encodes USDT → crvUSD → VUSD.                                                               |

Indices `i`/`j` are token positions inside each Curve pool. `swapType=1` (exchange), `poolType=1` (stable) or `10` (stable-ng). Only update if the underlying Curve pools migrate. The `sell` direction (VUSD → stablecoin) is auto-reversed by the bot.

### Deployment-only

Used by `forge script script/Deploy.s.sol`, not the keeper.

| Variable             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `KEEPER_ADDRESS`     | Initial keeper address to whitelist at deploy time       |
| `OWNER_ADDRESS`      | Contract owner (admin) address                           |
| `KEEPER_SHARE_BPS`   | Initial keeper profit share in bps (default 0, max 5000) |
| `ETHERSCAN_API_KEY`  | For `--verify`                                           |

## DEX Price Sources

The bot queries all enabled sources **in parallel** and picks the best price per direction:

- **Sell direction** (VUSD → stablecoin): highest output wins
- **Buy direction** (stablecoin → VUSD): lowest cost wins

Sources that fail, time out, or return no route are silently dropped. If **all** sources fail for a given direction the bot logs a warning and skips that tick.

| Source       | Type                | API key |
| ------------ | ------------------- | ------- |
| 1inch        | Aggregator API      | yes     |
| 0x / Matcha  | Aggregator API      | yes     |
| LiFi         | Aggregator API      | optional |
| Curve Router | On-chain multi-hop  | no      |

The Curve Router route (stablecoin → crvUSD → VUSD) is the only on-chain fallback. Aggregators may not index VUSD pools immediately after pool launch — Curve Router covers that gap.

## Dry-run Mode

Drop `PRIVATE_KEY` from `.env` (or comment it out) and run normally:

```bash
npm run dev
```

Startup banner shows:

```
Mode        : DRY-RUN (no PRIVATE_KEY — txs will be skipped)
```

The bot does everything except `executor.execute()`. Any opportunity that would have been submitted instead logs:

```
[Dry-run] PRIVATE_KEY not set — skipping tx submission
```

Use this mode to:
- Validate `.env` config before going live
- Observe price spreads / source availability without risk
- Test new RPC endpoints

## Running the Bot

```bash
npm run dev      # tsx, no build step (development)
npm run build    # tsc compile
npm start        # node dist/index.js (production)
```

Recommended for production: a process manager (systemd, pm2, docker restart-policy) — the bot has no internal restart logic. Restart on crash.

### Example startup output

```
[Keeper] Price sources: 0x → curve_router → default(1.0) | Flash loan: Morpho (0bps fee)
═══════════════════════════════════════════════════
  VUSD Arbitrage Keeper
═══════════════════════════════════════════════════
  Stablecoins : USDC, USDT
  Flash loan  : Morpho (0bps fee)
  Mode        : LIVE
  Min profit  : $5
  Poll        : 5s
  Flash tiers : >500bps→$2000, >200bps→$1000, >50bps→$500, >0bps→$500
═══════════════════════════════════════════════════
```

### Example per-tick output

```
[USDC] DEX sell quotes: lifi=0.995645, curve_router=0.997243 → using curve_router (0.997243)
[USDC] DEX buy  quotes: lifi=1.008339, curve_router=1.005829 → using curve_router (1.005829)
[12:08:06] [USDC] sell=$0.9972 buy=$1.0058 (BELOW peg, 28bps) | via curve_router/curve_router | MINT_AND_SELL spread=-28bps | flash=$500 | est=$-6.38 (min $5) | fees: mint=0bps redeem=0bps
```

### What "ACTIONABLE" / executed lines look like

```
[12:34:56] [USDC] >>> MINT_AND_SELL $500 USDC | spread=107bps | est profit=$0.37
[Simulation] MINT_AND_SELL USDC: profit = 0.42 USDC
[Execute] Tx submitted: 0xabc...
[Execute] Tx confirmed in block 19345678, gas used: 412345
[12:34:58] [USDC] ARB EXECUTED! Tx: 0xabc...
```

## Monitoring / Alerting Recommendations

Watch for:

| Signal                                                    | Meaning / Action                                         |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `Tick error:` repeating                                   | RPC issue or panic — restart, then investigate           |
| `All DEX <sell|buy> price sources failed`                 | Every source returned no route. Check API keys + Curve Router routes; verify VUSD pool still has liquidity |
| `Gas price too high`                                      | Normal during congestion; raise `MAX_GAS_PRICE_GWEI` if needed |
| `SKIP BUY_AND_REDEEM: Gateway has 0 USDC reserves`        | Expected when Gateway can't satisfy redeems              |
| `SKIP MINT_AND_SELL: Gateway mint cap reached`            | Expected when Gateway is full                            |
| Many `est=$-X.XX` over consecutive ticks                  | Not actionable — VUSD trading inside fee band. Normal.   |
| `ARB EXECUTED!` log lines                                 | Successful arb. Cross-check on-chain in Etherscan.       |

On-chain event to subscribe for execution monitoring:

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
# Build
forge build

# Unit tests (23 tests, no RPC needed)
forge test --mc VUSDArbitrageTest -vv

# Mainnet fork tests (2 tests, requires RPC)
ETHEREUM_RPC_URL=<your-rpc> forge test --mc VUSDArbitrageForkTest -vvv
```

## E2E Tests (Off-Chain Pipeline)

Tests the full TypeScript pipeline against mock contracts on local Anvil:

```bash
npm run test:e2e
```

Automatically starts Anvil, deploys mocks via `forge script`, runs MINT_AND_SELL / BUY_AND_REDEEM / at-peg-skip / below-threshold-skip scenarios, then shuts Anvil down.

## Mainnet Fork Smoke Test

Reproduce a real depeg on a forked mainnet:

```bash
# Terminal 1 — fork mainnet, push VUSD off-peg
./scripts/test_arb_fork.sh

# Terminal 2 — point the bot at the local fork
ETHEREUM_RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=<anvil-key-0> npm run dev
```

The first Anvil dev key works: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`.

## Threshold Sweep

Estimate how much external swap volume is needed to make each flash tier profitable. Pure analysis — no bot involved:

```bash
./scripts/calc_arb_thresholds.sh
```

Useful for tuning `FLASH_AMOUNT_TIERS` and `MIN_PROFIT_USD` before going live.

## Deploy Contract

```bash
# Required env
export ETHEREUM_RPC_URL=<rpc>
export PRIVATE_KEY=<deployer-key>
export KEEPER_ADDRESS=<initial-keeper>
export OWNER_ADDRESS=<admin>
export KEEPER_SHARE_BPS=1000          # optional, defaults to 0
export ETHERSCAN_API_KEY=<key>        # for --verify

forge script script/Deploy.s.sol --rpc-url $ETHEREUM_RPC_URL --broadcast --verify
```

After deployment:

1. Note the deployed `VUSDArbitrage` address from script output.
2. Update `src/constants.ts:VUSD_ARBITRAGE_ADDRESS` **or** set `VUSD_ARBITRAGE_ADDRESS=0x…` in `.env`.
3. Whitelist the contract on the Gateway for instant redeem (Gateway admin action — not in this repo).
4. Add additional keeper addresses on the contract via `addKeeper(address)` if needed.

## Contract Admin Functions

| Function                          | Access  | Description                                       |
| --------------------------------- | ------- | ------------------------------------------------- |
| `addKeeper(address)`              | Owner   | Whitelist a keeper                                |
| `removeKeeper(address)`           | Owner   | Remove a keeper                                   |
| `setKeeperRestriction(bool)`      | Owner   | Toggle the keeper whitelist (false = public)      |
| `setTreasury(address)`            | Owner   | Change profit recipient                           |
| `setKeeperShareBps(uint256)`      | Owner   | Change keeper profit share (max 5000 = 50%)       |
| `setGateway(address)`             | Owner   | Update the Gateway address                        |
| `setMorpho(address)`              | Owner   | Update the Morpho flash loan pool address         |
| `rescueTokens(address)`           | Keeper  | Sweep a stuck token to treasury                   |
| `emergencyWithdraw(token,to,amt)` | Owner   | Withdraw any token to any address                 |

## Troubleshooting

| Symptom                                                  | Cause / Fix                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Startup error `Missing required environment variable: ETHEREUM_RPC_URL` | `.env` not loaded or var not set                                                                            |
| `Mode: DRY-RUN` shown when you expected live              | `PRIVATE_KEY` not set or empty. Set it in `.env`.                                                                      |
| Every tick logs `No DEX quote available (all sources failed)` | All aggregator APIs returned no route AND Curve Router quote reverted. Verify `CURVE_ROUTER_ROUTE_*` envs, check VUSD pool liquidity. |
| Aggregator log shows price but Curve Router is missing    | The aggregator gave a quote; Curve Router quote failed (often because the pool path reverted). Not fatal — bot still picked best of what's available. |
| `[Simulation] Reverted: ...`                              | `staticCall` failed before submission. Reasons: keeper not whitelisted on contract (`NotKeeper`); minOut too tight (raise `SLIPPAGE_BPS`); Gateway capacity hit between price-fetch and simulation. |
| `[Execute] Gas price too high`                            | Network congestion. Raise `MAX_GAS_PRICE_GWEI` or wait.                                                                |
| `[Execute] Failed: insufficient funds`                    | Keeper wallet has no ETH. Top up gas.                                                                                  |
| `[Execute] Failed: NotKeeper`                             | The wallet behind `PRIVATE_KEY` is not whitelisted. Call `addKeeper(address)` on the contract or disable restriction.  |

## NPM Scripts

| Script             | Command            | Description                          |
| ------------------ | ------------------ | ------------------------------------ |
| `npm run dev`      | `tsx src/index.ts` | Run in dev mode (no build step)      |
| `npm run build`    | `tsc`              | Compile TypeScript                   |
| `npm start`        | `node dist/index.js` | Run compiled bot                   |
| `npm run lint`     | `tsc --noEmit`     | Type-check without emitting          |
| `npm run test:e2e` | `vitest run`       | Run E2E tests                        |
