#!/bin/bash
# ==============================================================================
# Test arb bot on Anvil mainnet fork by creating a price imbalance
#
# What this does:
# 1. Forks mainnet at latest block
# 2. Impersonates a crvUSD whale
# 3. Swaps 1000 crvUSD → VUSD on the crvUSD/VUSD pool (pushes VUSD sell price > $1)
# 4. Shows new pool balances and price quotes
# 5. You then point the bot at localhost:8545 to test
#
# Usage:
#   chmod +x scripts/test_arb_fork.sh
#   ./scripts/test_arb_fork.sh
#
# Then in another terminal:
#   ETHEREUM_RPC_URL=http://127.0.0.1:8545 npm run dev
# ==============================================================================

set -e

RPC="${ETHEREUM_RPC_URL:-https://eth-mainnet.g.alchemy.com/v2/QLc48ptvsz_WFIKXP_VMk3IX2AbqTBmn}"
ANVIL_RPC="http://127.0.0.1:8545"

# Contracts
GATEWAY="0xDaD503f8B9d42bb7af3AfC588358D30163e4416F"
VUSD="0xCa83DDE9c22254f58e771bE5E157773212AcBAc3"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
CRVUSD="0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E"
POOL_CRVUSD_VUSD="0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d"
POOL_USDC_CRVUSD="0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E"
CURVE_ROUTER="0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e"
Z="0x0000000000000000000000000000000000000000"

# crvUSD whale (Curve lending controller — holds lots of crvUSD)
WHALE="0xA920De414eA4Ab66b97dA1bFE9e6EcA7d4219635"

# Amount to swap (push price) — 1000 crvUSD
SWAP_AMOUNT="1000000000000000000000"  # 1000e18

echo "═══════════════════════════════════════════════════"
echo "  VUSD Arb Bot — Anvil Fork Test"
echo "═══════════════════════════════════════════════════"
echo ""

# 1. Start Anvil fork
echo ">>> Starting Anvil mainnet fork..."
anvil --fork-url "$RPC" --auto-impersonate --port 8545 &
ANVIL_PID=$!
sleep 3

cleanup() {
  echo ""
  echo ">>> Stopping Anvil (pid $ANVIL_PID)..."
  kill $ANVIL_PID 2>/dev/null || true
}
trap cleanup EXIT

# 2. Show current pool state
echo ""
echo ">>> Current pool balances:"
VUSD_BAL=$(cast call $POOL_CRVUSD_VUSD "balances(uint256)(uint256)" 0 --rpc-url $ANVIL_RPC)
CRVUSD_BAL=$(cast call $POOL_CRVUSD_VUSD "balances(uint256)(uint256)" 1 --rpc-url $ANVIL_RPC)
echo "  VUSD:   $(cast --from-wei ${VUSD_BAL%% *})"
echo "  crvUSD: $(cast --from-wei ${CRVUSD_BAL%% *})"

# 3. Show current prices
echo ""
echo ">>> Current DEX prices (before manipulation):"
SELL_OUT=$(cast call $CURVE_ROUTER \
  "get_dy(address[11],uint256[5][5],uint256)(uint256)" \
  "[$VUSD,$POOL_CRVUSD_VUSD,$CRVUSD,$POOL_USDC_CRVUSD,$USDC,$Z,$Z,$Z,$Z,$Z,$Z]" \
  "[[0,1,1,10,2],[1,0,1,1,2],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]" \
  "1000000000000000000000" \
  --rpc-url $ANVIL_RPC)
echo "  Sell 1000 VUSD → ${SELL_OUT} USDC"

# 4. Impersonate whale & approve crvUSD for pool
echo ""
echo ">>> Impersonating crvUSD whale: $WHALE"
echo ">>> Approving crvUSD for pool..."
cast send $CRVUSD \
  "approve(address,uint256)" $POOL_CRVUSD_VUSD $SWAP_AMOUNT \
  --from $WHALE --unlocked \
  --rpc-url $ANVIL_RPC > /dev/null

# 5. Swap crvUSD → VUSD on the pool (pushes VUSD price UP)
echo ">>> Swapping 1000 crvUSD → VUSD on pool (pushing VUSD sell price above $1)..."
cast send $POOL_CRVUSD_VUSD \
  "exchange(int128,int128,uint256,uint256)" 1 0 $SWAP_AMOUNT 0 \
  --from $WHALE --unlocked \
  --rpc-url $ANVIL_RPC > /dev/null

# 6. Show new pool state
echo ""
echo ">>> New pool balances (after manipulation):"
VUSD_BAL2=$(cast call $POOL_CRVUSD_VUSD "balances(uint256)(uint256)" 0 --rpc-url $ANVIL_RPC)
CRVUSD_BAL2=$(cast call $POOL_CRVUSD_VUSD "balances(uint256)(uint256)" 1 --rpc-url $ANVIL_RPC)
echo "  VUSD:   $(cast --from-wei ${VUSD_BAL2%% *})"
echo "  crvUSD: $(cast --from-wei ${CRVUSD_BAL2%% *})"

# 7. Show new prices
echo ""
echo ">>> New DEX prices (after manipulation):"
SELL_OUT2=$(cast call $CURVE_ROUTER \
  "get_dy(address[11],uint256[5][5],uint256)(uint256)" \
  "[$VUSD,$POOL_CRVUSD_VUSD,$CRVUSD,$POOL_USDC_CRVUSD,$USDC,$Z,$Z,$Z,$Z,$Z,$Z]" \
  "[[0,1,1,10,2],[1,0,1,1,2],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]" \
  "500000000000000000000" \
  --rpc-url $ANVIL_RPC)
echo "  Sell 500 VUSD → ${SELL_OUT2} USDC (sell price = ${SELL_OUT2%% *} / 500)"

BUY_OUT2=$(cast call $CURVE_ROUTER \
  "get_dy(address[11],uint256[5][5],uint256)(uint256)" \
  "[$USDC,$POOL_USDC_CRVUSD,$CRVUSD,$POOL_CRVUSD_VUSD,$VUSD,$Z,$Z,$Z,$Z,$Z,$Z]" \
  "[[0,1,1,1,2],[1,0,1,10,2],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]" \
  "500000000" \
  --rpc-url $ANVIL_RPC)
echo "  Buy  500 USDC → ${BUY_OUT2} VUSD"

# 8. Check Gateway capacity
echo ""
echo ">>> Gateway capacity:"
MAX_W=$(cast call $GATEWAY "maxWithdraw(address)(uint256)" $USDC --rpc-url $ANVIL_RPC)
echo "  maxWithdraw(USDC) = ${MAX_W}"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Anvil fork ready on $ANVIL_RPC"
echo "  Pool is now imbalanced — VUSD should be above peg"
echo ""
echo "  Run the bot in another terminal:"
echo "    ETHEREUM_RPC_URL=$ANVIL_RPC npm run dev"
echo ""
echo "  Press Ctrl+C to stop Anvil"
echo "═══════════════════════════════════════════════════"

# Keep alive
wait $ANVIL_PID
