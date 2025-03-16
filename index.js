require('dotenv').config();
const { ethers } = require('ethers');
const readline = require('readline');
const {
  COLORS,
  FACTORY_ADDRESS,
  SWAP_ROUTER_ADDRESS,
  WETH_ADDRESS,
  FEE_TIERS,
} = require('./constants');
const {
  getTokenDetails,
  getTokenPrice,
  executeSwap,
  getSafeGasPrice,
  sortTokens,
  withErrorHandling,
} = require('./utils');

// Define provider in index.js
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const factoryInterface = new ethers.Interface(['function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)']);
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryInterface, provider);
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
    // Validate mnemonic
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
    console.log(`Deriving wallet with path: ${path}`);
    const derivedWallet = ethers.HDNodeWallet.fromPhrase(process.env.MNEMONIC, undefined, path).connect(provider);
    wallets.push(derivedWallet);
    console.log(`Wallet ${i} address: ${derivedWallet.address}`);
  }

  const mainWalletBalance = await provider.getBalance(wallets[0].address);
  console.log(`${COLORS.BRIGHT_GREEN}\nMain Wallet (BIP-44 #0) Address: ${wallets[0].address} - Balance: ${ethers.formatEther(mainWalletBalance)} ETH${COLORS.RESET}`);
}

async function buyToken() {
  const tokenAddress = await askQuestion('Enter token address to buy: ');
  const ethAmount = await askQuestion('Enter ETH amount to spend: ');
  const amountIn = ethers.parseEther(ethAmount);

  const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallets[0].address, provider);
  if (tokenDetailsBefore.error) {
    console.error('Error fetching token details:', tokenDetailsBefore.error);
    return;
  }
  console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details Before Purchase ---${COLORS.RESET}`, tokenDetailsBefore);

  const confirm = await askQuestion(`Confirm buying ${ethAmount} ETH worth of ${tokenDetailsBefore.symbol}? (y/n): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('Transaction cancelled.');
    return;
  }

  if (dryRun) {
    console.log('Dry run: Simulating buy...');
    return;
  }

  let txHash;
  let success = false;
  for (const fee of FEE_TIERS) {
    const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
    const poolAddress = await factory.getPool(token0, token1, fee);
    if (poolAddress === ethers.ZeroAddress) {
      console.log(`No pool exists for fee tier ${fee}. Trying next tier...`);
      continue;
    }
    try {
      txHash = await executeSwap(wallets[0], WETH_ADDRESS, tokenAddress, amountIn, fee, provider, true);
      console.log('Transaction hash:', txHash);
      success = true;
      break;
    } catch (error) {
      console.log(`Fee tier ${fee} failed. Trying next tier...`, error.message);
    }
  }
  if (!success) {
    console.log('Could not complete purchase: No suitable fee tier found.');
    return;
  }

  const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallets[0].address, provider);
  if (!tokenDetailsAfter.error) {
    console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details After Purchase ---${COLORS.RESET}`, tokenDetailsAfter);
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
    console.error('Error fetching token details:', tokenDetailsBefore.error);
    return;
  }
  console.log(`${COLORS.BRIGHT_RED}\n--- Token Details Before Sale ---${COLORS.RESET}`, tokenDetailsBefore);

  const confirm = await askQuestion(`Confirm selling ${ethers.formatUnits(amountToSell, tokenDetailsBefore.decimals)} ${tokenDetailsBefore.symbol} (${percentage}%)? (y/n): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('Transaction cancelled.');
    return;
  }

  if (dryRun) {
    console.log('Dry run: Simulating sell...');
    return;
  }

  const allowance = await tokenContract.allowance(wallets[0].address, SWAP_ROUTER_ADDRESS);
  if (allowance < amountToSell) {
    const gasPrice = await getSafeGasPrice(provider);
    const approveTx = await tokenContract.approve(SWAP_ROUTER_ADDRESS, amountToSell, { gasPrice });
    await approveTx.wait();
  }

  let txHash;
  let success = false;
  for (const fee of FEE_TIERS) {
    const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
    const poolAddress = await factory.getPool(token0, token1, fee);
    if (poolAddress === ethers.ZeroAddress) {
      console.log(`No pool exists for fee tier ${fee}. Trying next tier...`);
      continue;
    }
    try {
      txHash = await executeSwap(wallets[0], tokenAddress, WETH_ADDRESS, amountToSell, fee, provider, false);
      console.log('Transaction hash:', txHash);

      const wethContract = new ethers.Contract(
        WETH_ADDRESS,
        [
          'function balanceOf(address) view returns (uint256)',
          'function withdraw(uint256 amount)',
        ],
        wallets[0]
      );
      const wethBalance = await wethContract.balanceOf(wallets[0].address);
      if (wethBalance > 0n) {
        const gasPrice = await getSafeGasPrice(provider);
        await wethContract.withdraw(wethBalance, { gasPrice });
        console.log('WETH withdrawn to ETH (Main Wallet, BIP-44 #0)');
      }
      success = true;
      break;
    } catch (error) {
      console.log(`Fee tier ${fee} failed. Trying next tier...`, error.message);
    }
  }
  if (!success) {
    console.log('Could not complete sale: No suitable fee tier found.');
    return;
  }

  const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallets[0].address, provider);
  if (!tokenDetailsAfter.error) {
    console.log(`${COLORS.BRIGHT_RED}\n--- Token Details After Sale ---${COLORS.RESET}`, tokenDetailsAfter);
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
}

async function showWalletBalances() {
  const tokenAddress = await askQuestion('Enter token address (or press Enter for ETH): ');
  console.log('\n--- Wallet Balances ---');

  if (tokenAddress.trim() === '') {
    const balances = await Promise.all(
      wallets.map(async (wallet, i) => {
        const balance = await provider.getBalance(wallet.address);
        return `Wallet ${i} address: ${wallet.address} -${COLORS.BRIGHT_BLUE} ETH Balance: ${ethers.formatEther(balance)} ETH${COLORS.RESET}`;
      })
    );
    console.log(balances.join('\n'));
  } else {
    const tokenDetails = await getTokenDetails(tokenAddress, wallets[0].address, provider);
    if (tokenDetails.error) {
      console.error('Error fetching token details:', tokenDetails.error);
      return;
    }
    console.log('\n--- Token Details ---', tokenDetails);

    const balances = await Promise.all(
      wallets.map(async (wallet, i) => {
        const balance = i === 0 ? tokenDetails.balance : (await getTokenDetails(tokenAddress, wallet.address, provider)).balance;
        return `Wallet ${i} address: ${wallet.address} -${COLORS.BRIGHT_BLUE}${tokenDetails.symbol} Balance: ${balance} ${tokenDetails.symbol}${COLORS.RESET}`;
      })
    );
    console.log(balances.join('\n'));
  }
}

async function buyWithMultipleWallets() {
  const tokenAddress = await askQuestion('Enter token address to buy: ');
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const minEthStr = await askQuestion('Enter minimum ETH amount to spend (e.g., 0.001): ');
  const maxEthStr = await askQuestion('Enter maximum ETH amount to spend (e.g., 0.01): ');
  const minEth = parseFloat(minEthStr);
  const maxEth = parseFloat(maxEthStr);

  if (isNaN(minEth) || isNaN(maxEth) || minEth <= 0 || maxEth <= minEth) {
    console.log('Invalid ETH range.');
    return;
  }

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
    const balance = await provider.getBalance(wallet.address);

    if (balance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
      console.log(`Wallet ${i} (${wallet.address}) has insufficient ETH: ${ethers.formatEther(balance)}`);
      continue;
    }

    const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (tokenDetailsBefore.error) continue;
    console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details Before Purchase (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsBefore);

    if (dryRun) {
      console.log(`Dry run: Simulating buy for Wallet ${i}...`);
      continue;
    }

    let txHash;
    let success = false;
    for (const fee of FEE_TIERS) {
      const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
      const poolAddress = await factory.getPool(token0, token1, fee);
      if (poolAddress === ethers.ZeroAddress) continue;
      try {
        txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, fee, provider, true);
        console.log(`Wallet ${i} transaction hash: ${txHash}`);
        success = true;
        break;
      } catch (error) {
        console.log(`Fee tier ${fee} failed for Wallet ${i}:`, error.message);
      }
    }
    if (!success) continue;

    const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (!tokenDetailsAfter.error) {
      console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details After Purchase (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsAfter);
    }
  }
}

async function buyWithWalletsDelayed() {
  const tokenAddress = await askQuestion('Enter token address to buy: ');
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const minEthStr = await askQuestion('Enter minimum ETH amount to spend (e.g., 0.001): ');
  const maxEthStr = await askQuestion('Enter maximum ETH amount to spend (e.g., 0.01): ');
  const minDelayStr = await askQuestion('Enter minimum delay in seconds (e.g., 2): ');
  const maxDelayStr = await askQuestion('Enter maximum delay in seconds (e.g., 60): ');

  const minEth = parseFloat(minEthStr);
  const maxEth = parseFloat(maxEthStr);
  const minDelay = parseInt(minDelayStr, 10);
  const maxDelay = parseInt(maxDelayStr, 10);

  if (isNaN(minEth) || isNaN(maxEth) || minEth <= 0 || maxEth <= minEth) {
    console.log('Invalid ETH range.');
    return;
  }
  if (isNaN(minDelay) || isNaN(maxDelay) || minDelay < 0 || maxDelay <= minDelay) {
    console.log('Invalid delay range.');
    return;
  }

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
    const balance = await provider.getBalance(wallet.address);

    if (balance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
      console.log(`Wallet ${i} (${wallet.address}) has insufficient ETH: ${ethers.formatEther(balance)}`);
      continue;
    }

    const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (tokenDetailsBefore.error) continue;
    console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details Before Purchase (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsBefore);

    if (dryRun) {
      console.log(`Dry run: Simulating buy for Wallet ${i}...`);
      continue;
    }

    let txHash;
    let success = false;
    for (const fee of FEE_TIERS) {
      const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
      const poolAddress = await factory.getPool(token0, token1, fee);
      if (poolAddress === ethers.ZeroAddress) continue;
      try {
        txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, fee, provider, true);
        console.log(`Wallet ${i} transaction hash: ${txHash}`);
        success = true;
        break;
      } catch (error) {
        console.log(`Fee tier ${fee} failed for Wallet ${i}:`, error.message);
      }
    }
    if (!success) continue;

    const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (!tokenDetailsAfter.error) {
      console.log(`${COLORS.BRIGHT_GREEN}\n--- Token Details After Purchase (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsAfter);
    }

    if (i < wallets.length - 1) {
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      console.log(`Waiting ${randomDelay.toFixed(2)} seconds...`);
      await delay(randomDelay * 1000);
    }
  }
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

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
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
      continue;
    }

    const amountToSell = (balance * BigInt(Math.round(percentage * 100))) / 10000n;
    const tokenDetailsBefore = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (tokenDetailsBefore.error) continue;
    console.log(`${COLORS.BRIGHT_RED}\n--- Token Details Before Sale (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsBefore);

    if (dryRun) {
      console.log(`Dry run: Simulating sell for Wallet ${i}...`);
      continue;
    }

    const allowance = await tokenContract.allowance(wallet.address, SWAP_ROUTER_ADDRESS);
    if (allowance < amountToSell) {
      const gasPrice = await getSafeGasPrice(provider);
      const approveTx = await tokenContract.approve(SWAP_ROUTER_ADDRESS, amountToSell, { gasPrice });
      await approveTx.wait();
    }

    let txHash;
    let success = false;
    for (const fee of FEE_TIERS) {
      const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
      const poolAddress = await factory.getPool(token0, token1, fee);
      if (poolAddress === ethers.ZeroAddress) continue;
      try {
        txHash = await executeSwap(wallet, tokenAddress, WETH_ADDRESS, amountToSell, fee, provider, false);
        console.log(`Wallet ${i} transaction hash: ${txHash}`);

        const wethContract = new ethers.Contract(
          WETH_ADDRESS,
          [
            'function balanceOf(address) view returns (uint256)',
            'function withdraw(uint256 amount)',
          ],
          wallet
        );
        const wethBalance = await wethContract.balanceOf(wallet.address);
        if (wethBalance > 0n) {
          const gasPrice = await getSafeGasPrice(provider);
          await wethContract.withdraw(wethBalance, { gasPrice });
          console.log(`Wallet ${i} withdrew ${ethers.formatEther(wethBalance)} ETH from WETH`);
        }
        success = true;
        break;
      } catch (error) {
        console.log(`Fee tier ${fee} failed for Wallet ${i}:`, error.message);
      }
    }
    if (!success) continue;

    const tokenDetailsAfter = await getTokenDetails(tokenAddress, wallet.address, provider);
    if (!tokenDetailsAfter.error) {
      console.log(`${COLORS.BRIGHT_RED}\n--- Token Details After Sale (Wallet ${i}) ---${COLORS.RESET}`, tokenDetailsAfter);
    }
  }
}

async function automateBuyAndSell() {
  const tokenAddress = await askQuestion('Enter token address to buy and sell: ');
  if (!ethers.isAddress(tokenAddress)) {
    console.log('Invalid token address.');
    return;
  }

  const minEthStr = await askQuestion('Enter minimum ETH amount to buy (e.g., 0.001): ');
  const maxEthStr = await askQuestion('Enter maximum ETH amount to buy (e.g., 0.01): ');
  const minSellPercentStr = await askQuestion('Enter minimum sell percentage (0-100): ');
  const maxSellPercentStr = await askQuestion('Enter maximum sell percentage (0-100): ');
  const minDelayStr = await askQuestion('Enter minimum delay between transactions in seconds (e.g., 1): ');
  const maxDelayStr = await askQuestion('Enter maximum delay between transactions in seconds (e.g., 10): ');

  const minEth = parseFloat(minEthStr);
  const maxEth = parseFloat(maxEthStr);
  const minSellPercent = parseFloat(minSellPercentStr);
  const maxSellPercent = parseFloat(maxSellPercentStr);
  const minDelay = parseFloat(minDelayStr);
  const maxDelay = parseFloat(maxDelayStr);

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

  for (let i = 0; i < wallets.length && !shouldStop; i++) {
    const wallet = wallets[i];
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
    const ethBalance = await provider.getBalance(wallet.address);

    if (ethBalance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
      console.log(`${COLORS.BRIGHT_YELLOW}Wallet ${i} has insufficient ETH: ${ethers.formatEther(ethBalance)}${COLORS.RESET}`);
      continue;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating initial buy for Wallet ${i}...`);
      continue;
    }

    let txHash;
    let success = false;
    for (const fee of FEE_TIERS) {
      const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
      const poolAddress = await factory.getPool(token0, token1, fee);
      if (poolAddress === ethers.ZeroAddress) continue;
      try {
        txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, fee, provider, true);
        console.log(`Initial Buy tx hash ${COLORS.BRIGHT_CYAN}(Wallet ${i})${COLORS.RESET}: ${txHash}`);
        success = true;
        break;
      } catch (error) {
        console.log(`Initial buy failed for Wallet ${i} with fee ${fee}:`, error.message);
      }
    }
    if (!success) {
      console.log(`Initial buy failed for Wallet ${i}: No suitable fee tier.`);
      continue;
    }

    if (i < wallets.length - 1) {
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      console.log(`Waiting ${randomDelay.toFixed(2)} seconds...`);
      await delay(randomDelay * 1000);
    }
  }

  while (!shouldStop) {
    const wallet = wallets[Math.floor(Math.random() * wallets.length)];
    const isBuy = Math.random() < 0.5;

    if (isBuy) {
      const randomEth = minEth + Math.random() * (maxEth - minEth);
      const amountIn = ethers.parseEther(randomEth.toFixed(6).toString());
      const ethBalance = await provider.getBalance(wallet.address);

      if (ethBalance < amountIn + ((await getSafeGasPrice(provider)) * 50000n)) {
        console.log(`${COLORS.BRIGHT_YELLOW}Wallet has insufficient ETH: ${ethers.formatEther(ethBalance)}${COLORS.RESET}`);
      } else if (!dryRun) {
        let txHash;
        let success = false;
        for (const fee of FEE_TIERS) {
          const [token0, token1] = sortTokens(WETH_ADDRESS, tokenAddress);
          const poolAddress = await factory.getPool(token0, token1, fee);
          if (poolAddress === ethers.ZeroAddress) {
            console.log(`No pool exists for fee tier ${fee}.`);
            continue;
          }
          try {
            txHash = await executeSwap(wallet, WETH_ADDRESS, tokenAddress, amountIn, fee, provider, true);
            console.log(`Random Buy tx hash ${COLORS.BRIGHT_CYAN}(Wallet ${wallets.indexOf(wallet)})${COLORS.RESET}: ${txHash}`);
            success = true;
            break;
          } catch (error) {
            console.log(`Random buy failed with fee ${fee}:`, error.message);
          }
        }
        if (!success) console.log('Random buy failed: No suitable fee tier.');
      } else {
        console.log(`Dry run: Simulating random buy...`);
      }
    } else {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'function balanceOf(address) view returns (uint256)',
          'function approve(address spender, uint256 amount) public returns (bool)',
          'function decimals() view returns (uint256)',
          'function allowance(address owner, address spender) view returns (uint256)',
        ],
        wallet
      );

      const balance = await tokenContract.balanceOf(wallet.address);
      if (balance === 0n) {
        console.log(`Wallet (${wallet.address}) has no tokens to sell.`);
      } else if (!dryRun) {
        const randomSellPercent = minSellPercent + Math.random() * (maxSellPercent - minSellPercent);
        const amountToSell = (balance * BigInt(Math.round(randomSellPercent * 100))) / 10000n;

        try {
          const allowance = await tokenContract.allowance(wallet.address, SWAP_ROUTER_ADDRESS);
          if (allowance < amountToSell) {
            const gasPrice = await getSafeGasPrice(provider);
            const approveTx = await tokenContract.approve(SWAP_ROUTER_ADDRESS, amountToSell, { gasPrice });
            await approveTx.wait();
            console.log(`Approved ${ethers.formatUnits(amountToSell, await tokenContract.decimals())} tokens for Wallet ${wallets.indexOf(wallet)}`);
          }

          let txHash;
          let success = false;
          for (const fee of FEE_TIERS) {
            const [token0, token1] = sortTokens(tokenAddress, WETH_ADDRESS);
            const poolAddress = await factory.getPool(token0, token1, fee);
            if (poolAddress === ethers.ZeroAddress) {
              console.log(`No pool exists for fee tier ${fee}.`);
              continue;
            }
            try {
              txHash = await executeSwap(wallet, tokenAddress, WETH_ADDRESS, amountToSell, fee, provider, false);
              console.log(`Sell tx hash ${COLORS.BRIGHT_CYAN}(Wallet ${wallets.indexOf(wallet)})${COLORS.RESET}: ${txHash}`);

              const wethContract = new ethers.Contract(
                WETH_ADDRESS,
                [
                  'function balanceOf(address) view returns (uint256)',
                  'function withdraw(uint256 amount)',
                ],
                wallet
              );
              const wethBalance = await wethContract.balanceOf(wallet.address);
              if (wethBalance > 0n) {
                const gasPrice = await getSafeGasPrice(provider);
                await wethContract.withdraw(wethBalance, { gasPrice });
                console.log(`Withdrew ${ethers.formatEther(wethBalance)} ETH from WETH`);
              }
              console.log(`${COLORS.BRIGHT_RED}Sold ${ethers.formatUnits(amountToSell, await tokenContract.decimals())} tokens (${randomSellPercent.toFixed(2)}%)${COLORS.RESET}`);
              success = true;
              break;
            } catch (error) {
              console.log(`Sell failed with fee ${fee}:`, error.message);
            }
          }
          if (!success) console.log('Sell failed: No suitable fee tier.');
        } catch (error) {
          console.log(`Error during sell operation:`, error.message);
        }
      } else {
        console.log(`Dry run: Simulating sell...`);
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

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const balance = await provider.getBalance(wallet.address);
    const totalCost = gasPrice * gasLimit + gasBuffer;
    const amountToSend = balance - totalCost;

    if (amountToSend <= 0n) {
      console.log(`Wallet ${i} (${wallet.address}) has insufficient ETH: ${ethers.formatEther(balance)} ETH`);
      continue;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating ETH send from Wallet ${i}...`);
      continue;
    }

    const tx = await wallet.sendTransaction({ to: recipient, value: amountToSend, gasPrice, gasLimit });
    console.log(`Wallet ${i} transaction hash: ${tx.hash}`);
    await tx.wait();
    console.log(`Wallet ${i} ETH transfer confirmed`);
  }
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
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const tokenContract = new ethers.Contract(
      tokenAddress,
      [
        'function balanceOf(address) view returns (uint256)',
        'function transfer(address to, uint256 amount) public returns (bool)',
      ],
      wallet
    );

    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance === 0n) {
      console.log(`Wallet ${i} (${wallet.address}) has no tokens to send.`);
      continue;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating token send from Wallet ${i}...`);
      continue;
    }

    const tx = await tokenContract.transfer(recipient, balance, { gasPrice });
    console.log(`Wallet ${i} transaction hash: ${tx.hash}`);
    await tx.wait();
    console.log(`Wallet ${i} token transfer confirmed`);
  }
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

  for (let i = 1; i < wallets.length; i++) {
    const wallet = wallets[i];
    const randomEth = minEth + Math.random() * (maxEth - minEth);
    const amountToSend = ethers.parseEther(randomEth.toFixed(6).toString());

    const remainingMainBalance = await provider.getBalance(mainWallet.address);
    const gasCost = gasPrice * gasLimit;

    if (remainingMainBalance < amountToSend + gasCost) {
      console.log(`Main Wallet has insufficient ETH remaining: ${ethers.formatEther(remainingMainBalance)} ETH`);
      break;
    }

    if (dryRun) {
      console.log(`Dry run: Simulating funding to Wallet ${i}...`);
      continue;
    }

    const tx = await mainWallet.sendTransaction({ to: wallet.address, value: amountToSend, gasPrice, gasLimit });
    console.log(`Transaction hash for Wallet ${i}: ${tx.hash}`);
    await tx.wait();
    console.log(`Wallet ${i} funded successfully`);
  }
}

async function start() {
  await initializeWallets();

  while (true) {
    const mainWalletBalance = await provider.getBalance(wallets[0].address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const blockNumber = await provider.getBlockNumber();

    console.log(`${COLORS.BRIGHT_CYAN}\n--- Menu ---${COLORS.RESET}`);
    console.log(`Network: Base | Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei | Block: ${blockNumber}`);
    console.log(`${COLORS.BRIGHT_GREEN}::Main Wallet:::(BALANCE: ${ethers.formatEther(mainWalletBalance)} ETH)${COLORS.RESET}`);
    console.log('(1). Buy Tokens');
    console.log('(2). Sell Tokens');
    console.log('(3). Send All ETH');
    console.log('(4). Send Tokens');
    console.log('');
    console.log(`${COLORS.BRIGHT_GREEN}:::Multiple Wallets:::${COLORS.RESET}`);
    console.log('(5). Show Wallet Balances');
    console.log('(6). Automate Buy and Sell');
    console.log(`(7). Sell Tokens from All ${wallets.length} Wallets`);
    console.log(`(8). Send All ETH from All ${wallets.length} Wallets`);
    console.log(`(9). Fund ETH from Main Wallet to Others`);
    console.log(`(10). Buy with ${wallets.length} Wallets`);
    console.log(`(11). Buy with ${wallets.length} Wallets (Delayed)`);
    console.log(`(12). Send Selected Token from All ${wallets.length} Wallets`);
    console.log('(13). Exit');

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
      case '10': await withErrorHandling(buyWithMultipleWallets, 'Buy with Multiple Wallets'); break;
      case '11': await withErrorHandling(buyWithWalletsDelayed, 'Buy with Wallets Delayed'); break;
      case '12': await withErrorHandling(sendTokenFromAllWallets, 'Send Token from All'); break;
      case '13':
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
