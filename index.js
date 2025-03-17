const { ethers } = require('ethers');
const readline = require('readline');
require('dotenv').config();
const {
  COLORS,
  V3_FACTORY_ADDRESS,
  V2_FACTORY_ADDRESS,
  WETH_ADDRESS,
  V3_FEE_TIERS,
  V2_FEE,
  V3_SWAP_ROUTER_ADDRESS,
  V2_ROUTER_ADDRESS,
  DEFAULT_SLIPPAGE,
} = require('./constants');
const {
  getTokenDetails,
  getTokenPrice,
  executeSwap,
  getSafeGasPrice,
  sortTokens,
  withErrorHandling,
} = require('./utils');

// Main Script
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const v3FactoryInterface = new ethers.Interface(['function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)']);
const v2FactoryInterface = new ethers.Interface(['function getPair(address tokenA, address tokenB) external view returns (address pair)']);
const v3Factory = new ethers.Contract(V3_FACTORY_ADDRESS, v3FactoryInterface, provider);
const v2Factory = new ethers.Contract(V2_FACTORY_ADDRESS, v2FactoryInterface, provider);
const dryRun = process.argv.includes('--dry-run');

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let wallets = [];
async function initializeWallets() {
  if (!process.env.MNEMONIC) {
    console.error('Error: MNEMONIC not found in .env file');
    process.exit(1);
  }
  try {
    ethers.HDNodeWallet.fromPhrase(process.env.MNEMONIC);
  } catch (error) {
    console.error('Error: Invalid MNEMONIC in .env file:', error.message);
    process.exit(1);
  }

  const numWalletsStr = await askQuestion('How many wallets to generate (1-100)? ');
  const numWallets = parseInt(numWalletsStr, 10);
  if (isNaN(numWallets) || numWallets < 1 || numWallets > 100) {
    console.log('Invalid input. Please enter a number between 1 and 100.');
    rl.close();
    process.exit(1);
  }

  for (let i = 0; i < numWallets; i++) {
    const path = `m/44'/60'/0'/0/${i}`;
    const derivedWallet = ethers.HDNodeWallet.fromPhrase(process.env.MNEMONIC, undefined, path).connect(provider);
    wallets.push(derivedWallet);
    console.log(`Wallet ${i} address: ${derivedWallet.address}`);
  }
}

async function buyToken() {
  const tokenAddress = await askQuestion('Enter token address to buy: ');
  const ethAmount = await askQuestion('Enter ETH amount to spend: ');
  const amountIn = ethers.parseEther(ethAmount);

  const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallets[0].address, provider);
  if (tokenDetailsBefore.error) {
    console.error('Error fetching token details before purchase:', tokenDetailsBefore.error);
    return;
  }
  console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details Before Purchase ---${COLORS.RESET}`, tokenDetailsBefore);

  const EXTENDED_FEE_TIERS = [100, 500, 3000, 10000, 30000, 100000];
  let priceInEth;
  let selectedFeeTier = null;
  let version = null;

  try {
    const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
    const pairAddress = await v2Factory.getPair(token0, token1);
    if (pairAddress !== ethers.ZeroAddress) {
      console.log(`V2 Pair found at: ${pairAddress}`);
      priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), V2_FEE, provider, 'v2');
      console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol}${COLORS.RESET}`);
      selectedFeeTier = V2_FEE;
      version = 'v2';
    }
  } catch (error) {
    console.log('No V2 liquidity found:', error.message);
  }

  if (!priceInEth) {
    try {
      for (const fee of EXTENDED_FEE_TIERS) {
        const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
        const poolAddress = await v3Factory.getPool(token0, token1, fee);
        if (poolAddress === ethers.ZeroAddress) continue;
        console.log(`V3 Pool found at: ${poolAddress}`);
        priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), fee, provider, 'v3');
        console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol} (Fee Tier: ${fee})${COLORS.RESET}`);
        selectedFeeTier = fee;
        version = 'v3';
        break;
      }
    } catch (error) {
      console.log('No V3 liquidity found:', error.message);
    }
  }

  if (!priceInEth) {
    console.log('No liquidity pools found on V2 or V3. Cannot proceed with purchase.');
    return;
  }

  const amountOut = parseFloat(priceInEth) * parseFloat(ethAmount);
  console.log(`Estimated (${version.toUpperCase()}): ${ethAmount} ETH will buy approximately ${amountOut.toFixed(6)} ${tokenDetailsBefore.symbol}`);

  const confirm = await askQuestion(`Confirm buying ${ethAmount} ETH worth of ${tokenDetailsBefore.symbol} using ${version.toUpperCase()} (Fee: ${selectedFeeTier})? (y/n): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('Transaction cancelled.');
    return;
  }

  if (dryRun) {
    console.log(`Dry run: Simulating buy on ${version.toUpperCase()}...`);
    return;
  }

  let txHash;
  try {
    txHash = await executeSwap(wallets[0], WETH_ADDRESS, tokenAddress, amountIn, selectedFeeTier, provider, true, DEFAULT_SLIPPAGE, version);
    console.log('Transaction hash:', txHash);
  } catch (error) {
    console.log(`Purchase failed on ${version.toUpperCase()} with fee ${selectedFeeTier}:`, error.message);
    return;
  }

  await delay(2000);
  const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallets[0].address, provider, true);
  if (!tokenDetailsAfter.error) {
    console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details After Purchase ---${COLORS.RESET}`, tokenDetailsAfter);
  } else {
    console.error('Error fetching token details after purchase:', tokenDetailsAfter.error);
  }
}

async function sellTokens() {
  const tokenAddress = await askQuestion('Enter token address to sell: ');
  const percentageStr = await askQuestion('Enter percentage to sell (0-100, press Enter for 100%): ');

  const tokenContract = new ethers.Contract(
    tokenAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function approve(address spender, uint256 amount) public returns (bool)',
      'function decimals() view returns (uint8)',
      'function allowance(address owner, address spender) view returns (uint256)',
    ],
    wallets[0]
  );
  const balance = await tokenContract.balanceOf(wallets[0].address);
  if (balance === 0n) {
    console.log('No tokens to sell (Main Wallet, BIP-44 #0).');
    return;
  }

  const percentage = percentageStr.trim() === '' ? 100 : parseFloat(percentageStr);
  if (isNaN(percentage) || percentage < 0 || percentage > 100) {
    console.log('Invalid percentage. Please enter a number between 0 and 100.');
    return;
  }
  const amountToSell = (balance * BigInt(Math.round(percentage * 100))) / 10000n;

  const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallets[0].address, provider);
  if (tokenDetailsBefore.error) {
    console.error('Error fetching token details before sale:', tokenDetailsBefore.error);
    return;
  }
  console.log(`${COLORS.BRIGHT_RED}\n--- Token Details Before Sale ---${COLORS.RESET}`, tokenDetailsBefore);

  let priceInEth;
  let selectedFeeTier = null;
  let version = null;

  try {
    const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
    const pairAddress = await v2Factory.getPair(token0, token1);
    if (pairAddress !== ethers.ZeroAddress) {
      console.log(`V2 Pair found at: ${pairAddress}`);
      priceInEth = await getTokenPrice(tokenAddress, WETH_ADDRESS, ethers.parseUnits('1', tokenDetailsBefore.decimals), V2_FEE, provider, 'v2');
      console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ${tokenDetailsBefore.symbol} = ${priceInEth} ETH${COLORS.RESET}`);
      selectedFeeTier = V2_FEE;
      version = 'v2';
    }
  } catch (error) {
    console.log('No V2 liquidity found:', error.message);
  }

  if (!priceInEth) {
    try {
      for (const fee of V3_FEE_TIERS) {
        const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
        const poolAddress = await v3Factory.getPool(token0, token1, fee);
        if (poolAddress === ethers.ZeroAddress) continue;
        console.log(`V3 Pool found at: ${poolAddress}`);
        priceInEth = await getTokenPrice(tokenAddress, WETH_ADDRESS, ethers.parseUnits('1', tokenDetailsBefore.decimals), fee, provider, 'v3');
        console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ${tokenDetailsBefore.symbol} = ${priceInEth} ETH (Fee Tier: ${fee})${COLORS.RESET}`);
        selectedFeeTier = fee;
        version = 'v3';
        break;
      }
    } catch (error) {
      console.log('No V3 liquidity found:', error.message);
    }
  }

  if (!priceInEth) {
    console.log('No liquidity pools found on V2 or V3. Cannot proceed with sale.');
    return;
  }

  const amountOut = (parseFloat(priceInEth) * parseFloat(ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals))).toFixed(6);
  console.log(`Estimated (${version.toUpperCase()}): Selling ${ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals)} ${tokenDetailsBefore.symbol} will yield approximately ${amountOut} ETH`);

  const confirm = await askQuestion(`Confirm selling ${ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals)} ${tokenDetailsBefore.symbol} (${percentage}%) using ${version.toUpperCase()} (Fee: ${selectedFeeTier})? (y/n): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('Transaction cancelled.');
    return;
  }

  if (dryRun) {
    console.log(`Dry run: Simulating sell on ${version.toUpperCase()}...`);
    return;
  }

  const allowance = await tokenContract.allowance(wallets[0].address, version === 'v3' ? V3_SWAP_ROUTER_ADDRESS : V2_ROUTER_ADDRESS);
  if (allowance < amountToSell) {
    const gasPrice = await getSafeGasPrice(provider);
    const approveTx = await tokenContract.approve(version === 'v3' ? V3_SWAP_ROUTER_ADDRESS : V2_ROUTER_ADDRESS, amountToSell, { gasPrice });
    await approveTx.wait();
  }

  let txHash;
  try {
    txHash = await executeSwap(wallets[0], tokenAddress, WETH_ADDRESS, amountToSell, selectedFeeTier, provider, false, DEFAULT_SLIPPAGE, version);
    console.log('Transaction hash:', txHash);

    const wethContract = new ethers.Contract(
      WETH_ADDRESS,
      ['function balanceOf(address) view returns (uint256)', 'function withdraw(uint256 amount)'],
      wallets[0]
    );
    const wethBalance = await wethContract.balanceOf(wallets[0].address);
    if (wethBalance > 0n) {
      const gasPrice = await getSafeGasPrice(provider);
      await wethContract.withdraw(wethBalance, { gasPrice });
      console.log('WETH withdrawn to ETH (Main Wallet, BIP-44 #0)');
    }
  } catch (error) {
    console.log(`Sale failed on ${version.toUpperCase()} with fee ${selectedFeeTier}:`, error.message);
    return;
  }

  const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallets[0].address, provider, true);
  if (!tokenDetailsAfter.error) {
    console.log(`${COLORS.BRIGHT_RED}\n--- Token Details After Sale ---${COLORS.RESET}`, tokenDetailsAfter);
  } else {
    console.error('Error fetching token details after sale:', tokenDetailsAfter.error);
  }
}

async function sendAllETH() {
  const recipient = await askQuestion('Enter recipient wallet address: ');
  if (!ethers.isAddress(recipient)) {
    console.log('Invalid address.');
    return;
  }

  const balance = await provider.getBalance(wallets[0].address);
  const gasPrice = await getSafeGasPrice(provider);
  const gasLimit = 21000n;
  const gasBuffer = ethers.parseEther('0.0001');
  const totalCost = gasPrice * gasLimit + gasBuffer;
  const amountToSend = balance - totalCost;

  if (amountToSend <= 0n) {
    console.log(`Insufficient ETH: ${ethers.formatEther(balance)} ETH`);
    return;
  }

  const confirm = await askQuestion(`Confirm sending ${ethers.formatEther(amountToSend)} ETH? (y/n): `);
  if (confirm.toLowerCase() !== 'y') return;

  if (dryRun) {
    console.log('Dry run: Simulating ETH send...');
    return;
  }

  const tx = await wallets[0].sendTransaction({ to: recipient, value: amountToSend, gasPrice, gasLimit });
  console.log('Transaction hash:', tx.hash);
  await tx.wait();
  console.log('ETH transfer confirmed (Main Wallet, BIP-44 #0)');
}

async function sendToken() {
  const tokenAddress = await askQuestion('Enter token address to send: ');
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const recipient = await askQuestion('Enter recipient wallet address: ');
  if (!ethers.isAddress(recipient)) {
    console.log('Invalid recipient address.');
    return;
  }

  const tokenContract = new ethers.Contract(
    tokenAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
      'function transfer(address to, uint256 amount) public returns (bool)',
    ],
    wallets[0]
  );

  const balance = await tokenContract.balanceOf(wallets[0].address);
  if (balance === 0n) {
    console.log('No tokens to send.');
    return;
  }

  const decimals = await tokenContract.decimals();
  const symbol = await tokenContract.symbol();
  console.log(`Main Wallet ${symbol} Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`);

  const percentageStr = await askQuestion('Enter percentage of tokens to send (0-100): ');
  const percentage = parseFloat(percentageStr);
  if (isNaN(percentage) || percentage < 0 || percentage > 100) {
    console.log('Invalid percentage.');
    return;
  }

  const amount = (balance * BigInt(Math.round(percentage * 100))) / 10000n;
  if (amount === 0n) {
    console.log('Calculated amount to send is 0.');
    return;
  }

  const formattedAmount = ethers.formatUnits(amount, decimals);
  const confirm = await askQuestion(`Confirm sending ${formattedAmount} ${symbol} (${percentage}%)? (y/n): `);
  if (confirm.toLowerCase() !== 'y') return;

  if (dryRun) {
    console.log('Dry run: Simulating token send...');
    return;
  }

  const gasPrice = await getSafeGasPrice(provider);
  const tx = await tokenContract.transfer(recipient, amount, { gasPrice });
  console.log('Transaction hash:', tx.hash);
  await tx.wait();
  console.log('Token transfer confirmed (Main Wallet, BIP-44 #0)');

  const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallets[0].address, provider, true);
  if (!tokenDetailsAfter.error) {
    console.log(`${COLORS.BRIGHT_CYAN}\n--- Token Details After Transfer ---${COLORS.RESET}`, tokenDetailsAfter);
  } else {
    console.error('Error fetching token details after transfer:', tokenDetailsAfter.error);
  }
}

async function showWalletBalances() {
  const tokenAddress = await askQuestion('Enter token address (or press Enter for ETH): ');
  console.log('\n--- Wallet Balances ---');

  if (wallets.length === 0) {
    console.log('No wallets initialized.');
    return;
  }

  if (tokenAddress.trim() === '') {
    const balances = await Promise.all(wallets.map(async (wallet, i) => {
      const balance = await provider.getBalance(wallet.address);
      return `Wallet ${i} address: ${wallet.address} -${COLORS.BRIGHT_BLUE} ETH Balance: ${ethers.formatEther(balance)} ETH${COLORS.RESET}`;
    }));
    console.log(balances.join('\n'));
  } else {
    const tokenDetails = await getTokenDetails(tokenAddress, wallets[0].address, provider, true);
    if (tokenDetails.error) {
      console.error('Error fetching token details:', tokenDetails.error);
      return;
    }

    const walletDetails = await Promise.all(wallets.map(wallet => 
      getTokenDetails(tokenAddress, wallet.address, provider, true)
    ));

    const totalBalance = walletDetails.reduce((sum, details) => {
      if (!details.error) return sum + parseFloat(details.balance);
      return sum;
    }, 0).toFixed(tokenDetails.decimals);

    console.log('\n--- Token Details ---', {
      name: tokenDetails.name,
      symbol: tokenDetails.symbol,
      decimals: tokenDetails.decimals,
      totalSupply: tokenDetails.totalSupply,
      totalBalance: `${totalBalance} ${tokenDetails.symbol}`
    });

    const balances = walletDetails.map((details, i) => {
      const balance = details.error ? 'Error' : details.balance;
      return `Wallet ${i} address: ${wallets[i].address} -${COLORS.BRIGHT_BLUE}${tokenDetails.symbol} Balance: ${balance} ${tokenDetails.symbol}${COLORS.RESET}`;
    });
    console.log(balances.join('\n'));
  }
}

async function buyWithWallets() {
  const minEthStr = await askQuestion('Enter minimum ETH amount to spend (e.g., 0.001): ');
  const maxEthStr = await askQuestion('Enter maximum ETH amount to spend (e.g., 0.01): ');
  const addDelay = await askQuestion('Do you want to add a delay between transactions? (y/n): ');
  let minDelay = 0;
  let maxDelay = 0;
  if (addDelay.toLowerCase() === 'y') {
    const minDelayStr = await askQuestion('Enter minimum delay in seconds (e.g., 2): ');
    const maxDelayStr = await askQuestion('Enter maximum delay in seconds (e.g., 60): ');
    minDelay = parseInt(minDelayStr, 10);
    maxDelay = parseInt(maxDelayStr, 10);

    if (isNaN(minDelay) || isNaN(maxDelay) || minDelay < 0 || maxDelay <= minDelay) {
      console.log('Invalid delay range. Proceeding without delay.');
      minDelay = 0;
      maxDelay = 0;
    }
  }
  const tokenAddress = await askQuestion('Enter token address to buy: ');
  
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const minEth = parseFloat(minEthStr);
  const maxEth = parseFloat(maxEthStr);

  if (isNaN(minEth) || isNaN(maxEth) || minEth <= 0 || maxEth <= minEth) {
    console.log('Invalid ETH range.');
    return;
  }

  const EXTENDED_FEE_TIERS = [100, 500, 3000, 10000, 30000, 100000];

  await Promise.all(wallets.map(async (wallet, i) => {
    console.log(`Processing wallet ${i + 1}/${wallets.length}...`);
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
    const balance = await provider.getBalance(wallet.address);

    if (balance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
      console.log(`Wallet ${i} (${wallet.address}) has insufficient ETH: ${ethers.formatEther(balance)}`);
      return;
    }

    const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (tokenDetailsBefore.error) return;
    console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details Before Purchase (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsBefore);

    let priceInEth;
    let selectedFeeTier = null;
    let version = null;

    try {
      const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
      const pairAddress = await v2Factory.getPair(token0, token1);
      if (pairAddress !== ethers.ZeroAddress) {
        console.log(`V2 Pair found at: ${pairAddress}`);
        priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), V2_FEE, provider, 'v2');
        console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol}${COLORS.RESET}`);
        selectedFeeTier = V2_FEE;
        version = 'v2';
      }
    } catch (error) {
      console.log('No V2 liquidity found:', error.message);
    }

    if (!priceInEth) {
      try {
        for (const fee of EXTENDED_FEE_TIERS) {
          const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
          const poolAddress = await v3Factory.getPool(token0, token1, fee);
          if (poolAddress === ethers.ZeroAddress) continue;
          console.log(`V3 Pool found at: ${poolAddress}`);
          priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), fee, provider, 'v3');
          console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol} (Fee Tier: ${fee})${COLORS.RESET}`);
          selectedFeeTier = fee;
          version = 'v3';
          break;
        }
      } catch (error) {
        console.log('No V3 liquidity found:', error.message);
      }
    }

    if (!priceInEth) {
      console.log(`No suitable liquidity found for Wallet ${i}. Skipping.`);
      return;
    }

    const amountOut = parseFloat(priceInEth) * parseFloat(randomEth.toFixed(6));
    console.log(`Estimated (${version.toUpperCase()}): ${randomEth.toFixed(6)} ETH will buy approximately ${amountOut.toFixed(6)} ${tokenDetailsBefore.symbol}`);

    if (dryRun) {
      console.log(`Dry run: Simulating buy for Wallet ${i} on ${version.toUpperCase()}...`);
      return;
    }

    let txHash;
    try {
      txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, selectedFeeTier, provider, true, DEFAULT_SLIPPAGE, version);
      console.log(`Wallet ${i} transaction hash: ${txHash}`);
    } catch (error) {
      console.log(`Buy failed for Wallet ${i} on ${version.toUpperCase()} with fee ${selectedFeeTier}:`, error.message);
      return;
    }

    const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider, true);
    if (!tokenDetailsAfter.error) {
      console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details After Purchase (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsAfter);
    }

    if (minDelay > 0 && maxDelay > 0 && i < wallets.length - 1) {
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      console.log(`Waiting ${randomDelay.toFixed(2)} seconds...`);
      await delay(randomDelay * 1000);
    }
  }));
}

async function sellAllTokensFromAllWallets() {
  const tokenAddress = await askQuestion('Enter token address to sell from all wallets: ');
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }
  const percentageStr = await askQuestion('Enter percentage to sell (0-100, press Enter for 100%): ');

  const percentage = percentageStr.trim() === '' ? 100 : parseFloat(percentageStr);
  if (isNaN(percentage) || percentage < 0 || percentage > 100) {
    console.log('Invalid percentage.');
    return;
  }

  await Promise.all(wallets.map(async (wallet, i) => {
    console.log(`Processing wallet ${i + 1}/${wallets.length}...`);
    const tokenContract = new ethers.Contract(
      tokenAddress,
      [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address spender, uint256 amount) public returns (bool)',
        'function decimals() view returns (uint8)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ],
      wallet
    );

    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance === 0n) {
      console.log(`Wallet ${i} (${wallet.address}) has no tokens to sell.`);
      return;
    }

    const amountToSell = (balance * BigInt(Math.round(percentage * 100))) / 10000n;
    const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (tokenDetailsBefore.error) return;
    console.log(`${COLORS.BRIGHT_RED}\n--- Token Details Before Sale (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsBefore);

    let priceInEth;
    let selectedFeeTier = null;
    let version = null;

    try {
      const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
      const pairAddress = await v2Factory.getPair(token0, token1);
      if (pairAddress !== ethers.ZeroAddress) {
        console.log(`V2 Pair found at: ${pairAddress}`);
        priceInEth = await getTokenPrice(tokenAddress, WETH_ADDRESS, ethers.parseUnits('1', tokenDetailsBefore.decimals), V2_FEE, provider, 'v2');
        console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ${tokenDetailsBefore.symbol} = ${priceInEth} ETH${COLORS.RESET}`);
        selectedFeeTier = V2_FEE;
        version = 'v2';
      }
    } catch (error) {
      console.log('No V2 liquidity found:', error.message);
    }

    if (!priceInEth) {
      try {
        for (const fee of V3_FEE_TIERS) {
          const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
          const poolAddress = await v3Factory.getPool(token0, token1, fee);
          if (poolAddress === ethers.ZeroAddress) continue;
          console.log(`V3 Pool found at: ${poolAddress}`);
          priceInEth = await getTokenPrice(tokenAddress, WETH_ADDRESS, ethers.parseUnits('1', tokenDetailsBefore.decimals), fee, provider, 'v3');
          console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ${tokenDetailsBefore.symbol} = ${priceInEth} ETH (Fee Tier: ${fee})${COLORS.RESET}`);
          selectedFeeTier = fee;
          version = 'v3';
          break;
        }
      } catch (error) {
        console.log('No V3 liquidity found:', error.message);
      }
    }

    if (!priceInEth) {
      console.log(`No suitable liquidity found for Wallet ${i}. Skipping.`);
      return;
    }

    const amountOut = (parseFloat(priceInEth) * parseFloat(ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals))).toFixed(6);
    console.log(`Estimated (${version.toUpperCase()}): Selling ${ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals)} ${tokenDetailsBefore.symbol} will yield approximately ${amountOut} ETH`);

    if (dryRun) {
      console.log(`Dry run: Simulating sell for Wallet ${i} on ${version.toUpperCase()}...`);
      return;
    }

    const allowance = await tokenContract.allowance(wallet.address, version === 'v3' ? V3_SWAP_ROUTER_ADDRESS : V2_ROUTER_ADDRESS);
    if (allowance < amountToSell) {
      const gasPrice = await getSafeGasPrice(provider);
      const approveTx = await tokenContract.approve(version === 'v3' ? V3_SWAP_ROUTER_ADDRESS : V2_ROUTER_ADDRESS, amountToSell, { gasPrice });
      await approveTx.wait();
    }

    let txHash;
    try {
      txHash = await executeSwap(wallet, tokenAddress, WETH_ADDRESS, amountToSell, selectedFeeTier, provider, false, DEFAULT_SLIPPAGE, version);
      console.log(`Wallet ${i} transaction hash: ${txHash}`);

      const wethContract = new ethers.Contract(
        WETH_ADDRESS,
        ['function balanceOf(address) view returns (uint256)', 'function withdraw(uint256 amount)'],
        wallet
      );
      const wethBalance = await wethContract.balanceOf(wallet.address);
      if (wethBalance > 0n) {
        const gasPrice = await getSafeGasPrice(provider);
        await wethContract.withdraw(wethBalance, { gasPrice });
        console.log(`Wallet ${i} withdrew ${ethers.formatEther(wethBalance)} ETH from WETH`);
      }
    } catch (error) {
      console.log(`Sell failed for Wallet ${i} on ${version.toUpperCase()} with fee ${selectedFeeTier}:`, error.message);
      return;
    }

    const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider, true);
    if (!tokenDetailsAfter.error) {
      console.log(`${COLORS.BRIGHT_RED}\n--- Token Details After Sale (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsAfter);
    }
  }));
}

async function automateBuyAndSell() {
  const minEthStr = await askQuestion('Enter minimum ETH amount to buy (e.g., 0.001): ');
  const maxEthStr = await askQuestion('Enter maximum ETH amount to buy (e.g., 0.01): ');
  const minSellPercentStr = await askQuestion('Enter minimum sell percentage (0-100): ');
  const maxSellPercentStr = await askQuestion('Enter maximum sell percentage (0-100): ');
  const minDelayStr = await askQuestion('Enter minimum delay between transactions in seconds (e.g., 1): ');
  const maxDelayStr = await askQuestion('Enter maximum delay between transactions in seconds (e.g., 10): ');
  const slippageStr = await askQuestion('Enter bearable slippage percentage (0-100, press Enter for default 0.5%): ');
  const tokenAddress = await askQuestion('Enter token address to buy and sell: ');

  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const minEth = parseFloat(minEthStr);
  const maxEth = parseFloat(maxEthStr);
  const minSellPercent = parseFloat(minSellPercentStr);
  const maxSellPercent = parseFloat(maxSellPercentStr);
  const minDelay = parseFloat(minDelayStr);
  const maxDelay = parseFloat(maxDelayStr);
  let slippage = DEFAULT_SLIPPAGE;

  if (slippageStr.trim() !== '') {
    const slippageInput = parseFloat(slippageStr);
    if (isNaN(slippageInput) || slippageInput < 0 || slippageInput > 100) {
      console.log('Invalid slippage percentage. Using default 0.5%.');
    } else {
      slippage = slippageInput / 100;
      console.log(`Using custom slippage: ${slippageInput}% (${slippage})`);
    }
  } else {
    console.log(`Using default slippage: 0.5% (${DEFAULT_SLIPPAGE})`);
  }

  if (isNaN(minEth) || isNaN(maxEth) || minEth <= 0 || maxEth <= minEth) {
    console.log('Invalid ETH range.');
    return;
  }
  if (isNaN(minSellPercent) || isNaN(maxSellPercent) || minSellPercent < 0 || maxSellPercent > 100 || minSellPercent >= maxSellPercent) {
    console.log('Invalid sell percentage range.');
    return;
  }
  if (isNaN(minDelay) || isNaN(maxDelay) || minDelay < 0 || maxDelay <= minDelay) {
    console.log('Invalid delay range.');
    return;
  }

  console.log(`Automation started. First ${wallets.length} transactions will be buys, then random. Type "STOP" to end.`);
  let shouldStop = false;

  rl.on('line', (input) => {
    if (input.trim().toUpperCase() === 'STOP') shouldStop = true;
  });

  const EXTENDED_FEE_TIERS = [100, 500, 3000, 10000, 30000, 100000];

  // Initial buys (sequential)
  for (const [i, wallet] of wallets.entries()) {
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
    const ethBalance = await provider.getBalance(wallet.address);

    if (ethBalance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
      console.log(`${COLORS.BRIGHT_YELLOW}Wallet ${i} has insufficient ETH: ${ethers.formatEther(ethBalance)}${COLORS.RESET}`);
      continue;
    }

    const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (tokenDetailsBefore.error) continue;

    let priceInEth;
    let selectedFeeTier = null;
    let version = null;

    try {
      const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
      const pairAddress = await v2Factory.getPair(token0, token1);
      if (pairAddress !== ethers.ZeroAddress) {
        console.log(`V2 Pair found at: ${pairAddress}`);
        priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), V2_FEE, provider, 'v2');
        console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol}${COLORS.RESET}`);
        selectedFeeTier = V2_FEE;
        version = 'v2';
      }
    } catch (error) {
      console.log('No V2 liquidity found:', error.message);
    }

    if (!priceInEth) {
      try {
        for (const fee of EXTENDED_FEE_TIERS) {
          const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
          const poolAddress = await v3Factory.getPool(token0, token1, fee);
          if (poolAddress === ethers.ZeroAddress) continue;
          console.log(`V3 Pool found at: ${poolAddress}`);
          priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), fee, provider, 'v3');
          console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol} (Fee Tier: ${fee})${COLORS.RESET}`);
          selectedFeeTier = fee;
          version = 'v3';
          break;
        }
      } catch (error) {
        console.log('No V3 liquidity found:', error.message);
      }
    }

    if (!priceInEth) {
      console.log(`No liquidity found for Wallet ${i}. Skipping initial buy.`);
      continue;
    }

    const amountOut = parseFloat(priceInEth) * parseFloat(randomEth.toFixed(6));
    console.log(`Estimated (${version.toUpperCase()}): ${randomEth.toFixed(6)} ETH will buy approximately ${amountOut.toFixed(6)} ${tokenDetailsBefore.symbol}`);

    if (!dryRun) {
      let txHash;
      try {
        const balanceBefore = BigInt(tokenDetailsBefore.balance * (10 ** tokenDetailsBefore.decimals));
        const nonce = await provider.getTransactionCount(wallet.address, 'pending');
        txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, selectedFeeTier, provider, true, slippage, version, nonce);
        console.log(`Initial Buy tx hash ${COLORS.BRIGHT_CYAN}(Wallet ${i})${COLORS.RESET}: ${txHash}`);
        await provider.waitForTransaction(txHash);
        const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider, true);
        if (!tokenDetailsAfter.error) {
          const balanceAfter = BigInt(tokenDetailsAfter.balance * (10 ** tokenDetailsAfter.decimals));
          const amountBought = ethers.formatUnits(balanceAfter - balanceBefore, tokenDetailsAfter.decimals);
          console.log(`${COLORS.BRIGHT_GREEN}Bought ${amountBought} ${tokenDetailsBefore.symbol}${COLORS.RESET}`);
        }
      } catch (error) {
        console.log(`Initial buy failed for Wallet ${i} on ${version.toUpperCase()} with fee ${selectedFeeTier}:`, error.message);
      }
    } else {
      console.log(`Dry run: Simulating initial buy for Wallet ${i}...`);
    }
  }

  // Random buy/sell loop (sequential)
  while (!shouldStop) {
    const walletIndex = Math.floor(Math.random() * wallets.length);
    const wallet = wallets[walletIndex];
    const isBuy = Math.random() < 0.5;

    if (isBuy) {
      const randomEth = minEth + Math.random() * (maxEth - minEth);
      const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
      const ethBalance = await provider.getBalance(wallet.address);

      if (ethBalance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
        console.log(`${COLORS.BRIGHT_YELLOW}Wallet ${walletIndex} has insufficient ETH: ${ethers.formatEther(ethBalance)}${COLORS.RESET}`);
      } else {
        const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
        if (tokenDetailsBefore.error) continue;

        let priceInEth;
        let selectedFeeTier = null;
        let version = null;

        try {
          const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
          const pairAddress = await v2Factory.getPair(token0, token1);
          if (pairAddress !== ethers.ZeroAddress) {
            console.log(`V2 Pair found at: ${pairAddress}`);
            priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), V2_FEE, provider, 'v2');
            console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol}${COLORS.RESET}`);
            selectedFeeTier = V2_FEE;
            version = 'v2';
          }
        } catch (error) {
          console.log('No V2 liquidity found:', error.message);
        }

        if (!priceInEth) {
          try {
            for (const fee of EXTENDED_FEE_TIERS) {
              const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
              const poolAddress = await v3Factory.getPool(token0, token1, fee);
              if (poolAddress === ethers.ZeroAddress) continue;
              console.log(`V3 Pool found at: ${poolAddress}`);
              priceInEth = await getTokenPrice(WETH_ADDRESS, tokenAddress, ethers.parseEther('1'), fee, provider, 'v3');
              console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ETH = ${priceInEth} ${tokenDetailsBefore.symbol} (Fee Tier: ${fee})${COLORS.RESET}`);
              selectedFeeTier = fee;
              version = 'v3';
              break;
            }
          } catch (error) {
            console.log('No V3 liquidity found:', error.message);
          }
        }

        if (!priceInEth) {
          console.log(`No liquidity found for Wallet ${walletIndex}. Skipping buy.`);
          continue;
        }

        const amountOut = parseFloat(priceInEth) * parseFloat(randomEth.toFixed(6));
        console.log(`Estimated (${version.toUpperCase()}): ${randomEth.toFixed(6)} ETH will buy approximately ${amountOut.toFixed(6)} ${tokenDetailsBefore.symbol}`);

        if (!dryRun) {
          let txHash;
          try {
            const balanceBefore = BigInt(tokenDetailsBefore.balance * (10 ** tokenDetailsBefore.decimals));
            const nonce = await provider.getTransactionCount(wallet.address, 'pending');
            txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, selectedFeeTier, provider, true, slippage, version, nonce);
            console.log(`Random Buy tx hash ${COLORS.BRIGHT_CYAN}(Wallet ${walletIndex})${COLORS.RESET}: ${txHash}`);
            await provider.waitForTransaction(txHash);
            const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider, true);
            if (!tokenDetailsAfter.error) {
              const balanceAfter = BigInt(tokenDetailsAfter.balance * (10 ** tokenDetailsAfter.decimals));
              const amountBought = ethers.formatUnits(balanceAfter - balanceBefore, tokenDetailsAfter.decimals);
              console.log(`${COLORS.BRIGHT_GREEN}Bought ${amountBought} ${tokenDetailsBefore.symbol}${COLORS.RESET}`);
            }
          } catch (error) {
            console.log(`Random buy failed on ${version.toUpperCase()} with fee ${selectedFeeTier} for Wallet ${walletIndex}:`, error.message);
          }
        } else {
          console.log(`Dry run: Simulating random buy...`);
        }
      }
    } else {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)',
          'function allowance(address owner, address spender) view returns (uint256)',
          'function approve(address spender, uint256 amount) public returns (bool)',
        ],
        wallet
      );

      const balance = await tokenContract.balanceOf(wallet.address);
      if (balance === 0n) {
        console.log(`Wallet (${wallet.address}) has no tokens to sell.`);
      } else {
        const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
        if (tokenDetailsBefore.error) continue;

        const randomSellPercent = minSellPercent + Math.random() * (maxSellPercent - minSellPercent);
        const amountToSell = (balance * BigInt(Math.round(randomSellPercent * 100))) / 10000n;

        let priceInEth;
        let selectedFeeTier = null;
        let version = null;

        try {
          const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
          const pairAddress = await v2Factory.getPair(token0, token1);
          if (pairAddress !== ethers.ZeroAddress) {
            console.log(`V2 Pair found at: ${pairAddress}`);
            priceInEth = await getTokenPrice(tokenAddress, WETH_ADDRESS, ethers.parseUnits('1', tokenDetailsBefore.decimals), V2_FEE, provider, 'v2');
            console.log(`${COLORS.BRIGHT_CYAN}V2 Price: 1 ${tokenDetailsBefore.symbol} = ${priceInEth} ETH${COLORS.RESET}`);
            selectedFeeTier = V2_FEE;
            version = 'v2';
          }
        } catch (error) {
          console.log('No V2 liquidity found:', error.message);
        }

        if (!priceInEth) {
          try {
            for (const fee of EXTENDED_FEE_TIERS) {
              const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
              const poolAddress = await v3Factory.getPool(token0, token1, fee);
              if (poolAddress === ethers.ZeroAddress) continue;
              console.log(`V3 Pool found at: ${poolAddress}`);
              priceInEth = await getTokenPrice(tokenAddress, WETH_ADDRESS, ethers.parseUnits('1', tokenDetailsBefore.decimals), fee, provider, 'v3');
              console.log(`${COLORS.BRIGHT_CYAN}V3 Price: 1 ${tokenDetailsBefore.symbol} = ${priceInEth} ETH (Fee Tier: ${fee})${COLORS.RESET}`);
              selectedFeeTier = fee;
              version = 'v3';
              break;
            }
          } catch (error) {
            console.log('No V3 liquidity found:', error.message);
          }
        }

        if (!priceInEth) {
          console.log(`No liquidity found for Wallet ${walletIndex}. Skipping sell.`);
          continue;
        }

        const amountOut = (parseFloat(priceInEth) * parseFloat(ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals))).toFixed(6);
        console.log(`Estimated (${version.toUpperCase()}): Selling ${ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals)} ${tokenDetailsBefore.symbol} will yield approximately ${amountOut} ETH`);

        if (!dryRun) {
          let txHash;
          try {
            const allowance = await tokenContract.allowance(wallet.address, V3_SWAP_ROUTER_ADDRESS);
            if (allowance < amountToSell) {
              console.log(`${COLORS.BRIGHT_YELLOW}Approving V3 Router for ${tokenAddress}...${COLORS.RESET}`);
              const gasPrice = await getSafeGasPrice(provider);
              const approveTx = await tokenContract.approve(V3_SWAP_ROUTER_ADDRESS, ethers.MaxUint256, { gasPrice });
              await approveTx.wait();
              console.log(`${COLORS.BRIGHT_GREEN}Approval successful.${COLORS.RESET}`);
            }

            const nonce = await provider.getTransactionCount(wallet.address, 'pending');
            txHash = await executeSwap(wallet, tokenAddress, WETH_ADDRESS, amountToSell, selectedFeeTier, provider, false, slippage, version, nonce);
            console.log(`Sell tx hash ${COLORS.BRIGHT_CYAN}(Wallet ${walletIndex})${COLORS.RESET}: ${txHash}`);
            await provider.waitForTransaction(txHash);

            const wethContract = new ethers.Contract(
              WETH_ADDRESS,
              ['function balanceOf(address) view returns (uint256)', 'function withdraw(uint256 amount)'],
              wallet
            );
            const wethBalance = await wethContract.balanceOf(wallet.address);
            if (wethBalance > 0n) {
              const gasPrice = await getSafeGasPrice(provider);
              const withdrawTx = await wethContract.withdraw(wethBalance, { gasPrice });
              await withdrawTx.wait();
              console.log(`Withdrew ${ethers.formatEther(wethBalance)} ETH from WETH`);
            }
            console.log(`${COLORS.BRIGHT_RED}Sold ${ethers.formatUnits(amountToSell, await tokenContract.decimals())} ${tokenDetailsBefore.symbol} (${randomSellPercent.toFixed(2)}%)${COLORS.RESET}`);
          } catch (error) {
            console.log(`Sell failed on ${version.toUpperCase()} with fee ${selectedFeeTier} for Wallet ${walletIndex}:`, error.message);
          }
        } else {
          console.log(`Dry run: Simulating sell...`);
        }
      }
    }

    if (!shouldStop) {
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      console.log(`Waiting ${randomDelay.toFixed(2)} seconds...`);
      await delay(randomDelay * 1000);
    }
  }

  console.log('Automation stopped.');
  rl.removeAllListeners('line');
}

async function sendAllETHFromAllWallets() {
  const recipient = await askQuestion('Enter recipient wallet address to send all ETH: ');
  if (!ethers.isAddress(recipient)) {
    console.log('Invalid recipient address.');
    return;
  }

  const gasPrice = await getSafeGasPrice(provider);
  const gasLimit = 21000n;
  const gasBuffer = ethers.parseEther('0.0001');

  await Promise.all(wallets.map(async (wallet, i) => {
    const balance = await provider.getBalance(wallet.address);
    const totalCost = gasPrice * gasLimit + gasBuffer;
    const amountToSend = balance - totalCost;

    if (amountToSend <= 0n) {
      console.log(`Wallet ${i} (${wallet.address}) has insufficient ETH: ${ethers.formatEther(balance)} ETH`);
      return;
    }

    const confirm = await askQuestion(`Confirm sending ${ethers.formatEther(amountToSend)} ETH from Wallet ${i} (${wallet.address})? (y/n): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log(`ETH transfer cancelled for Wallet ${i}.`);
      return;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating ETH send from Wallet ${i}...`);
      return;
    }

    const tx = await wallet.sendTransaction({ to: recipient, value: amountToSend, gasPrice, gasLimit });
    console.log(`Wallet ${i} transaction hash: ${tx.hash}`);
    await tx.wait();
    console.log(`Wallet ${i} ETH transfer confirmed`);
  }));
}

async function sendTokenFromAllWallets() {
  const tokenAddress = await askQuestion('Enter token address to send from all wallets: ');
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const recipient = await askQuestion('Enter recipient wallet address: ');
  if (!ethers.isAddress(recipient)) {
    console.log('Invalid recipient address.');
    return;
  }

  const gasPrice = await getSafeGasPrice(provider);
  await Promise.all(wallets.map(async (wallet, i) => {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) public returns (bool)'],
      wallet
    );

    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance === 0n) {
      console.log(`Wallet ${i} (${wallet.address}) has no tokens to send.`);
      return;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating token send from Wallet ${i}...`);
      return;
    }

    const tx = await tokenContract.transfer(recipient, balance, { gasPrice });
    console.log(`Wallet ${i} transaction hash: ${tx.hash}`);
    await tx.wait();
    console.log(`Wallet ${i} token transfer confirmed`);
  }));
}

async function fundETHToWallets() {
  const minEthStr = await askQuestion('Enter minimum ETH amount to fund (e.g., 0.0005): ');
  const maxEthStr = await askQuestion('Enter maximum ETH amount to fund (e.g., 1): ');

  const minEth = parseFloat(minEthStr);
  const maxEth = parseFloat(maxEthStr);

  if (isNaN(minEth) || isNaN(maxEth) || minEth <= 0 || maxEth <= minEth) {
    console.log('Invalid ETH range.');
    return;
  }

  const mainWallet = wallets[0];
  const mainBalance = await provider.getBalance(mainWallet.address);
  const gasPrice = await getSafeGasPrice(provider);
  const gasLimit = 21000n;

  const totalGasCost = gasPrice * gasLimit * BigInt(wallets.length - 1);
  const availableBalance = mainBalance - totalGasCost;

  if (availableBalance <= 0n) {
    console.log(`Main Wallet has insufficient ETH: ${ethers.formatEther(mainBalance)} ETH`);
    return;
  }

  await Promise.all(wallets.slice(1).map(async (wallet, i) => {
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountToSend = ethers.parseEther(randomEth.toFixed(6).toString());

    const remainingMainBalance = await provider.getBalance(mainWallet.address);
    const gasCost = gasPrice * gasLimit;

    if (remainingMainBalance < amountToSend + gasCost) {
      console.log(`Main Wallet has insufficient ETH remaining: ${ethers.formatEther(remainingMainBalance)} ETH`);
      return;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating funding to Wallet ${i + 1}...`);
      return;
    }

    const tx = await mainWallet.sendTransaction({ to: wallet.address, value: amountToSend, gasPrice, gasLimit });
    console.log(`Transaction hash for Wallet ${i + 1}: ${tx.hash}`);
    await tx.wait();
    console.log(`Wallet ${i + 1} funded successfully`);
  }));
}

async function start() {
  await initializeWallets();

  while (true) {
    const mainWalletBalance = await provider.getBalance(wallets[0].address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const blockNumber = await provider.getBlockNumber();

    console.log(`${COLORS.BRIGHT_CYAN}\n[[[[[[[[[[[[--- Menu ---]]]]]]]]]]]]${COLORS.RESET}`);
    console.log(`Network: Base | Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei | Block: ${blockNumber}`);
    console.log(`${COLORS.BRIGHT_GREEN}::Main Wallet:::(${wallets[0].address})${COLORS.BRIGHT_CYAN}(${ethers.formatEther(mainWalletBalance)} ETH)${COLORS.RESET}`);
    console.log('(1). Buy Tokens');
    console.log('(2). Sell Tokens');
    console.log(`${COLORS.BRIGHT_RED}(3). *Send All ETH*${COLORS.RESET}`);
    console.log('(4). Send Tokens');
    console.log('');
    console.log(`${COLORS.BRIGHT_GREEN}:::Multiple Wallets:::${COLORS.RESET}`);
    console.log('(5). Show Wallet Balances');
    console.log(`${COLORS.BRIGHT_CYAN}(6). Automate Buy and Sell${COLORS.RESET}`);
    console.log(`(7). Sell Tokens from All ${wallets.length} Wallets`);
    console.log(`${COLORS.BRIGHT_RED}(8). *Send All ETH from All ${wallets.length} Wallets*${COLORS.RESET}`);
    console.log(`(9). Fund ETH from Main Wallet to Others`);
    console.log(`(10). Buy with ${wallets.length} Wallets`);
    console.log(`(11). Send Selected Token from All ${wallets.length} Wallets`);
    console.log('(12). Exit');

    const choice = await askQuestion('Choose an option: ');
    switch (choice) {
      case '1': await withErrorHandling(buyToken, 'Buy Token'); break;
      case '2': await withErrorHandling(sellTokens, 'Sell Tokens'); break;
      case '3': await withErrorHandling(sendAllETH, 'Send All ETH'); break;
      case '4': await withErrorHandling(sendToken, 'Send Token'); break;
      case '5': await withErrorHandling(showWalletBalances, 'Show Wallet Balances'); break;
      case '6': await withErrorHandling(automateBuyAndSell, 'Automate Buy and Sell'); break;
      case '7': await withErrorHandling(sellAllTokensFromAllWallets, 'Sell All Tokens'); break;
      case '8': await withErrorHandling(sendAllETHFromAllWallets, 'Send All ETH from All'); break;
      case '9': await withErrorHandling(fundETHToWallets, 'Fund ETH to Wallets'); break;
      case '10': await withErrorHandling(buyWithWallets, 'Buy with Wallets'); break;
      case '11': await withErrorHandling(sendTokenFromAllWallets, 'Send Token from All'); break;
      case '12':
        console.log('Exiting...');
        rl.close();
        process.exit(0);
      default:
        console.log('Invalid choice.');
    }
  }
}

start().catch(error => {
  console.error('Unexpected error:', error);
  rl.close();
});