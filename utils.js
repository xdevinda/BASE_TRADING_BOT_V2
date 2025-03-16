const { ethers } = require('ethers');
const {
  COLORS,
  FACTORY_ADDRESS,
  SWAP_ROUTER_ADDRESS,
  QUOTER_ADDRESS,
  WETH_ADDRESS,
  FEE_TIERS,
  MAX_GAS_PRICE,
  DEFAULT_SLIPPAGE,
} = require('./constants');

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
// ... (rest of getTokenDetails unchanged)

async function getTokenPrice(tokenIn, tokenOut, amountIn, fee) {
  const quoterInterface = new ethers.Interface([
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)',
  ]);
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterInterface, provider);
  console.log(`Calling Quoter at ${QUOTER_ADDRESS} with tokenIn: ${tokenIn}, tokenOut: ${tokenOut}, fee: ${fee}`);
  try {
    const amountOut = await quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
    const decimalsOut = (await getTokenDetails(tokenOut)).decimals;
    return ethers.formatUnits(amountOut, decimalsOut);
  } catch (error) {
    console.log(`Quoter failed: ${error.message}`);
    throw error;
  }
}

async function executeSwap(wallet, tokenIn, tokenOut, amountIn, fee, isBuy = true, slippageTolerance = DEFAULT_SLIPPAGE) {
  const swapRouterInterface = new ethers.Interface([
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  ]);
  const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, swapRouterInterface, wallet);

  let amountOutMin = 0n;
  if (isBuy) {
    try {
      const price = await getTokenPrice(tokenIn, tokenOut, amountIn, fee);
      amountOutMin = ethers.parseUnits(
        (parseFloat(price) * (1 - slippageTolerance)).toString(),
        (await getTokenDetails(tokenOut)).decimals
      );
    } catch (error) {
      console.log(`Failed to get price for slippage, proceeding with amountOutMin = 0: ${error.message}`);
      amountOutMin = 0n;
    }
  }

  const gasPrice = await getSafeGasPrice();
  const params = [tokenIn, tokenOut, fee, wallet.address, amountIn, amountOutMin, 0];
  const tx = isBuy
    ? await swapRouter.exactInputSingle(params, { value: amountIn, gasPrice, gasLimit: 500000 })
    : await swapRouter.exactInputSingle(params, { gasPrice });
  await tx.wait();
  return tx.hash;
}

async function getSafeGasPrice() {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  return gasPrice > MAX_GAS_PRICE ? MAX_GAS_PRICE : gasPrice;
}

// ... (rest of utils.js unchanged: sortTokens, withErrorHandling, exports)
