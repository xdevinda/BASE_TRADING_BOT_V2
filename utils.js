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
  MULTICALL_ADDRESS,
} = require('./constants');

// Multicall ABI (simplified)
const MULTICALL_ABI = [
  'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
];

const tokenDetailsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getTokenDetails(tokenAddress, walletAddress, provider, forceRefresh = false) {
  const cacheKey = `${tokenAddress}-${walletAddress}`;
  const cached = tokenDetailsCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.details;
  }

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

    const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
    const calls = [
      [tokenAddress, tokenContract.interface.encodeFunctionData('name')],
      [tokenAddress, tokenContract.interface.encodeFunctionData('symbol')],
      [tokenAddress, tokenContract.interface.encodeFunctionData('decimals')],
      [tokenAddress, tokenContract.interface.encodeFunctionData('totalSupply')],
      [tokenAddress, tokenContract.interface.encodeFunctionData('balanceOf', [walletAddress])],
    ];

    const [, returnData] = await multicall.aggregate(calls);

    const name = tokenContract.interface.decodeFunctionResult('name', returnData[0])[0] || 'Unknown';
    const symbol = tokenContract.interface.decodeFunctionResult('symbol', returnData[1])[0] || 'Unknown';
    const decimals = Number(tokenContract.interface.decodeFunctionResult('decimals', returnData[2])[0]) || 18;
    const totalSupply = tokenContract.interface.decodeFunctionResult('totalSupply', returnData[3])[0] || BigInt(0);
    const balance = tokenContract.interface.decodeFunctionResult('balanceOf', returnData[4])[0] || BigInt(0);

    const details = {
      name,
      symbol,
      decimals,
      totalSupply: ethers.formatUnits(totalSupply, decimals),
      balance: ethers.formatUnits(balance, decimals),
    };
    tokenDetailsCache.set(cacheKey, { details, timestamp: Date.now() });
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

  // Only check and approve if tokenIn is not WETH (since WETH doesn't need approval when buying with ETH)
  if (tokenIn !== WETH_ADDRESS) {
    const tokenContract = new ethers.Contract(
      tokenIn,
      [
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) public returns (bool)',
      ],
      wallet
    );

    const currentAllowance = await tokenContract.allowance(wallet.address, SWAP_ROUTER_ADDRESS);
    if (currentAllowance < amountIn) {
      console.log(`${COLORS.BRIGHT_YELLOW}Approving Swap Router for unlimited ${tokenIn} usage...${COLORS.RESET}`);
      const gasPrice = await getSafeGasPrice(provider);
      const approveTx = await tokenContract.approve(SWAP_ROUTER_ADDRESS, ethers.MaxUint256, { gasPrice });
      await approveTx.wait();
      console.log(`${COLORS.BRIGHT_GREEN}Approval successful.${COLORS.RESET}`);
    }
  }

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