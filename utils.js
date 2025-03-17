const { ethers } = require('ethers');
const {
  COLORS,
  V3_FACTORY_ADDRESS,
  V3_SWAP_ROUTER_ADDRESS,
  V3_QUOTER_ADDRESS,
  V2_FACTORY_ADDRESS,
  V2_ROUTER_ADDRESS,
  WETH_ADDRESS,
  V3_FEE_TIERS,
  V2_FEE,
  MAX_GAS_PRICE,
  DEFAULT_SLIPPAGE,
  MULTICALL_ADDRESS,
} = require('./constants');

// Multicall ABI
const MULTICALL_ABI = [
  'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
];

// Uniswap V2 Router ABI
const V2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory amounts)',
];

// Uniswap V3 Router ABI
const V3_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
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

async function getTokenPrice(tokenIn, tokenOut, amountIn, fee, provider, version = 'v3') {
  if (version === 'v3') {
    const quoterInterface = new ethers.Interface([
      'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) calldata params) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    ]);
    const quoter = new ethers.Contract(V3_QUOTER_ADDRESS, quoterInterface, provider);
    const [amountOut] = await quoter.quoteExactInputSingle({
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0,
    });
    const decimalsOut = (await getTokenDetails(tokenOut, tokenOut, provider)).decimals;
    return ethers.formatUnits(amountOut, decimalsOut);
  } else if (version === 'v2') {
    const router = new ethers.Contract(V2_ROUTER_ADDRESS, V2_ROUTER_ABI, provider);
    const path = [tokenIn, tokenOut];
    const amounts = await router.getAmountsOut(amountIn, path);
    const decimalsOut = (await getTokenDetails(tokenOut, tokenOut, provider)).decimals;
    return ethers.formatUnits(amounts[1], decimalsOut);
  }
}

async function executeSwap(wallet, tokenIn, tokenOut, amountIn, fee, provider, isBuy = true, slippageTolerance = DEFAULT_SLIPPAGE, version = 'v3', nonce = null) {
  const gasPrice = await getSafeGasPrice(provider);

  if (version === 'v3') {
    const swapRouter = new ethers.Contract(V3_SWAP_ROUTER_ADDRESS, V3_ROUTER_ABI, wallet);
    let amountOutMin = 0n;

    if (isBuy) {
      try {
        const price = await getTokenPrice(tokenIn, tokenOut, amountIn, fee, provider, 'v3');
        amountOutMin = ethers.parseUnits(
          (parseFloat(price) * (1 - slippageTolerance)).toFixed(18),
          (await getTokenDetails(tokenOut, wallet.address, provider)).decimals
        );
      } catch (error) {
        console.log('Error calculating amountOutMin for V3 buy:', error.message);
        amountOutMin = 0n;
      }
    } else {
      try {
        const price = await getTokenPrice(tokenIn, tokenOut, ethers.parseUnits('1', (await getTokenDetails(tokenIn, wallet.address, provider)).decimals), fee, provider, 'v3');
        const amountOut = parseFloat(price) * parseFloat(ethers.formatUnits(amountIn, (await getTokenDetails(tokenIn, wallet.address, provider)).decimals));
        amountOutMin = ethers.parseUnits(
          (amountOut * (1 - slippageTolerance)).toFixed(18),
          18 // ETH decimals
        );
      } catch (error) {
        console.log('Error calculating amountOutMin for V3 sell:', error.message);
        amountOutMin = 0n;
      }
    }

    const params = {
      tokenIn,
      tokenOut,
      fee,
      recipient: wallet.address,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0,
    };

    let data;
    try {
      data = swapRouter.interface.encodeFunctionData('exactInputSingle', [params]);
    } catch (error) {
      console.log('Error encoding V3 swap data:', error.message);
      throw new Error('Failed to encode swap data');
    }

    const txOptions = {
      to: V3_SWAP_ROUTER_ADDRESS,
      data,
      value: isBuy ? amountIn : 0,
      gasPrice,
      gasLimit: 500000,
    };
    if (nonce !== null) txOptions.nonce = nonce;

    const tx = await wallet.sendTransaction(txOptions);
    const receipt = await tx.wait();
    return receipt.hash;
  } else if (version === 'v2') {
    const router = new ethers.Contract(V2_ROUTER_ADDRESS, V2_ROUTER_ABI, wallet);
    const path = [tokenIn, tokenOut];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
    let amountOutMin = 0n;

    if (isBuy) {
      try {
        const price = await getTokenPrice(tokenIn, tokenOut, amountIn, V2_FEE, provider, 'v2');
        amountOutMin = ethers.parseUnits(
          (parseFloat(price) * (1 - slippageTolerance)).toFixed(18),
          (await getTokenDetails(tokenOut, wallet.address, provider)).decimals
        );
      } catch (error) {
        console.log('Error calculating amountOutMin for V2 buy:', error.message);
        amountOutMin = 0n;
      }
      const args = [amountOutMin, path, wallet.address, deadline];
      const data = router.interface.encodeFunctionData('swapExactETHForTokens', args);

      const txOptions = {
        to: V2_ROUTER_ADDRESS,
        data,
        value: amountIn,
        gasPrice,
        gasLimit: 500000,
      };
      if (nonce !== null) txOptions.nonce = nonce;

      const tx = await wallet.sendTransaction(txOptions);
      const receipt = await tx.wait();
      return receipt.hash;
    } else {
      try {
        const price = await getTokenPrice(tokenIn, tokenOut, ethers.parseUnits('1', (await getTokenDetails(tokenIn, wallet.address, provider)).decimals), V2_FEE, provider, 'v2');
        const amountOut = parseFloat(price) * parseFloat(ethers.formatUnits(amountIn, (await getTokenDetails(tokenIn, wallet.address, provider)).decimals));
        amountOutMin = ethers.parseUnits(
          (amountOut * (1 - slippageTolerance)).toFixed(18),
          18
        );
      } catch (error) {
        console.log('Error calculating amountOutMin for V2 sell:', error.message);
        amountOutMin = 0n;
      }

      if (tokenIn !== WETH_ADDRESS) {
        const tokenContract = new ethers.Contract(
          tokenIn,
          [
            'function allowance(address owner, address spender) view returns (uint256)',
            'function approve(address spender, uint256 amount) public returns (bool)',
          ],
          wallet
        );

        const currentAllowance = await tokenContract.allowance(wallet.address, V2_ROUTER_ADDRESS);
        if (currentAllowance < amountIn) {
          console.log(`${COLORS.BRIGHT_YELLOW}Approving V2 Router for ${tokenIn}...${COLORS.RESET}`);
          const approveTx = await tokenContract.approve(V2_ROUTER_ADDRESS, ethers.MaxUint256, { gasPrice });
          await approveTx.wait();
          console.log(`${COLORS.BRIGHT_GREEN}Approval successful.${COLORS.RESET}`);
        }
      }

      try {
        const args = [amountIn, amountOutMin, path, wallet.address, deadline];
        const data = router.interface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', args);

        const txOptions = {
          to: V2_ROUTER_ADDRESS,
          data,
          gasPrice,
          gasLimit: 500000,
        };
        if (nonce !== null) txOptions.nonce = nonce;

        const tx = await wallet.sendTransaction(txOptions);
        const receipt = await tx.wait();
        return receipt.hash;
      } catch (error) {
        console.log('Fee-on-transfer sell failed, trying standard swap:', error.message);
        const args = [amountIn, amountOutMin, path, wallet.address, deadline];
        const data = router.interface.encodeFunctionData('swapExactTokensForETH', args);

        const txOptions = {
          to: V2_ROUTER_ADDRESS,
          data,
          gasPrice,
          gasLimit: 500000,
        };
        if (nonce !== null) txOptions.nonce = nonce;

        const tx = await wallet.sendTransaction(txOptions);
        const receipt = await tx.wait();
        return receipt.hash;
      }
    }
  }
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