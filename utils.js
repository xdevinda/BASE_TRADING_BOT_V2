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
const tokenDetailsCache = new Map();

async function getTokenDetails(tokenAddress, walletAddress) {
  const cacheKey = `${tokenAddress}-${walletAddress}`;
  if (tokenDetailsCache.has(cacheKey)) return tokenDetailsCache.get(cacheKey);

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
      tokenContract.name().catch(() => 'Unknown'),
      tokenContract.symbol().catch(() => 'Unknown'),
      tokenContract.decimals().catch(() => 18),
      tokenContract.totalSupply().catch(() => BigInt(0)),
      tokenContract.balanceOf(walletAddress).catch(() => BigInt(0)),
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
    return { error: error.message };
  }
}

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
  const gasPrice = await provider.getGasPrice();
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
  provider,
};
