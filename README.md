# VUSD Arbitrage Bot

Flashloan-funded arbitrage between [Vetro Gateway](https://vetro.finance) mint/redeem and DEX prices for VUSD:USDC and VUSD:USDT pairs.

**Goal:** Bring VUSD DEX price to peg (1:1) and earn profit.

## How It Works

| DEX Price | Direction | Flow |
|-----------|-----------|------|
| VUSD > $1 | `mintAndSell` | Flashloan USDC → Mint VUSD via Gateway → Sell VUSD on DEX → Repay loan → Keep profit |
| VUSD < $1 | `buyAndRedeem` | Flashloan USDC → Buy cheap VUSD on DEX → Redeem via Gateway → Repay loan → Keep profit |

- **Zero capital required** — funded entirely by flashloans (Morpho, Aave V3, Balancer)
- **Profit split** — configurable keeper share (BPS), remainder goes to treasury
- **Off-chain keeper** — monitors prices, simulates via `staticCall`, executes when profitable

## Project Structure

```
contracts/           Solidity contracts (Foundry)
  VUSDArbitrage.sol  Core arbitrage contract
  interfaces/        Gateway, Aave, Morpho, Balancer interfaces
script/              Foundry deployment script
test/                Unit tests + mainnet fork tests
src/                 TypeScript keeper bot
  index.ts           Entry point
  keeper.ts          Main monitoring loop
  priceMonitor.ts    DEX price + Gateway preview queries
  profitCalculator.ts  Opportunity evaluation
  swapBuilder.ts     Paraswap API integration
  executor.ts        staticCall simulation + tx execution
  config.ts          Environment config loader
  types.ts           Shared types
```

## Prerequisites

- [Foundry](https://getfoundry.sh/) (forge, cast)
- Node.js >= 18
- Ethereum RPC URL (Alchemy, Infura, etc.)

## Setup

```bash
# Install Solidity dependencies
forge install

# Install TypeScript dependencies
npm install

# Copy and fill environment variables
cp .env.example .env
```

## Build & Test (Contracts)

```bash
# Build
forge build

# Run unit tests (23 tests, no RPC needed)
forge test --mc VUSDArbitrageTest -vv

# Run mainnet fork tests (5 tests, requires RPC)
ETHEREUM_RPC_URL=<your-rpc> forge test --mc VUSDArbitrageForkTest -vvv
```

## Deploy Contract

```bash
# Fill .env with deployment params, then:
source .env
forge script script/Deploy.s.sol --rpc-url $ETHEREUM_RPC_URL --broadcast --verify
```

After deployment:
1. Set `VUSD_ARBITRAGE_ADDRESS` in `.env`
2. Whitelist the contract on Gateway for instant redeem
3. Add keeper address(es) if needed

## Run Keeper Bot

```bash
# Build TypeScript
npm run build

# Run (production)
npm start

# Run (development, no build step)
npm run dev
```

The keeper will:
1. Poll DEX prices every `POLL_INTERVAL_MS`
2. Evaluate arb opportunities for each stablecoin
3. Simulate via `staticCall` before executing
4. Submit tx if simulated profit exceeds `MIN_PROFIT_USD`

## Key Configuration (.env)

| Variable | Description |
|----------|-------------|
| `ETHEREUM_RPC_URL` | RPC endpoint |
| `PRIVATE_KEY` | Keeper wallet private key |
| `VUSD_ARBITRAGE_ADDRESS` | Deployed arb contract address |
| `GATEWAY_ADDRESS` | Vetro Gateway address |
| `VUSD_ADDRESS` | VUSD token address |
| `MIN_PROFIT_USD` | Minimum profit to execute (default: 5) |
| `MAX_GAS_PRICE_GWEI` | Skip if gas above this (default: 50) |
| `SLIPPAGE_BPS` | DEX slippage tolerance (default: 50 = 0.5%) |
| `KEEPER_SHARE_BPS` | Keeper profit share in BPS (set on contract) |

## Contract Admin Functions

| Function | Access | Description |
|----------|--------|-------------|
| `addKeeper` / `removeKeeper` | Owner | Manage whitelisted keepers |
| `setKeeperRestriction(bool)` | Owner | Toggle keeper whitelist (false = anyone can call) |
| `setTreasury` | Owner | Change profit recipient |
| `setKeeperShareBps` | Owner | Change keeper profit share (max 50%) |
| `setProviderAddress` | Owner | Set/update flashloan provider addresses |
| `rescueTokens` | Keeper | Send stuck tokens to treasury |
| `emergencyWithdraw` | Owner | Withdraw any tokens to any address |
