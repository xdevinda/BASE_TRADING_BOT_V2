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

const tokenDetailsCache = new Map();

async function getTokenDetails(tokenAddress, walletAddress, provider, forceRefresh = false) {
  const cacheKey = `${tokenAddress}-${walletAddress}`;
  if (forceRefresh) tokenDetailsCache.delete(cacheKey); // Clear cache if forced

  if (tokenDetailsCache.has(cacheKey) && !forceRefresh) return tokenDetailsCache.get(cacheKey);

  if (!ethers.isAddress(tokenAddress)) return { error: 'Invalid token address' };

  try {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ],
      provider
    );

    const [name, symbol, decimals, totalSupply, balance] = await Promise.all([
      tokenContract.name().catch((e) => { console.log(`Name fetch failed: ${e.message}`); return 'Unknown'; }),
      tokenContract.symbol().catch((e) => { console.log(`Symbol fetch failed: ${e.message}`); return 'Unknown'; }),
      tokenContract.decimals().catch((e) => { console.log(`Decimals fetch failed: ${e.message}`); return 18; }),
      tokenContract.totalSupply().catch((e) => { console.log(`TotalSupply fetch failed: ${e.message}`); return BigInt(0); }),
      tokenContract.balanceOf(walletAddress).catch((e) => { console.log(`Balance fetch failed for ${walletAddress}: ${e.message}`); return BigInt(0); }),
    ]);

    const details = {
      name,
      symbol,
      decimals,
      totalSupply: ethers.formatUnits(totalSupply, decimals),
      balance: ethers.formatUnits(balance, decimals),
    };
    tokenDetailsCache.set(cacheKey, details);
    return details;
  } catch (error) {
    console.log(`Error in getTokenDetails for ${tokenAddress}: ${error.message}`);
    return { error: error.message };
  }
}

async function getTokenPrice(tokenIn, tokenOut, amountIn, fee, provider) {
  const quoterInterface = new ethers.Interface([
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) calldata params) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  ]);
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterInterface, provider);
  const [amountOut] = await quoter.quoteExactInputSingle({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  });
  const decimalsOut = (await getTokenDetails(tokenOut, tokenOut, provider)).decimals;
  return ethers.formatUnits(amountOut, decimalsOut);
}

async function executeSwap(wallet, tokenIn, tokenOut, amountIn, fee, provider, isBuy = true, slippageTolerance = DEFAULT_SLIPPAGE) {
  const swapRouterInterface = new ethers.Interface([
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  ]);
  const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, swapRouterInterface, wallet);

  let amountOutMin = 0n;
  if (isBuy) {
    try {
      const price = await getTokenPrice(tokenIn, tokenOut, amountIn, fee, provider);
      amountOutMin = ethers.parseUnits(
        (parseFloat(price) * (1 - slippageTolerance)).toString(),
        (await getTokenDetails(tokenOut, wallet.address, provider)).decimals
      );
    } catch (error) {
      amountOutMin = 0n;
    }
  }

  const gasPrice = await getSafeGasPrice(provider);
  const params = [tokenIn, tokenOut, fee, wallet.address, amountIn, amountOutMin, 0];
  const tx = isBuy
    ? await swapRouter.exactInputSingle(params, { value: amountIn, gasPrice, gasLimit: 500000 })
    : await swapRouter.exactInputSingle(params, { gasPrice });
  await tx.wait();
  return tx.hash;
}

async function getSafeGasPrice(provider) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  return gasPrice > MAX_GAS_PRICE ? MAX_GAS_PRICE : gasPrice;
}

function sortTokens(tokenA, tokenB) {
  const lowerA = tokenA.toLowerCase();
  const lowerB = tokenB.toLowerCase();
  return lowerA < lowerB ? [tokenA, tokenB] : [tokenB, tokenA];
}

async function withErrorHandling(fn, actionName) {
  try {
    await fn();
  } catch (error) {
    console.error(`Error in ${actionName}:`, error.message);
  }
}

module.exports = {
  getTokenDetails,
  getTokenPrice,
  executeSwap,
  getSafeGasPrice,
  sortTokens,
  withErrorHandling,
};
