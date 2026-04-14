
private_key = ""  # Replace with your private key

ONE_INCH_API_KEY = ""

from web3 import Web3
import json
import time
import requests

# Connect to Base network
rpc_url = "https://mainnet.base.org"
w3 = Web3(Web3.HTTPProvider(rpc_url))

# Your wallet details
private_key = ""  # Replace with your private key
account = w3.eth.account.from_key(private_key)
wallet_address = account.address

# 1inch API endpoint for Base (chain ID 8453)
ONE_INCH_API_BASE = "https://api.1inch.dev/swap/v6.0/8453"
ONE_INCH_ROUTER = w3.to_checksum_address("")  # Checksum address

# Your 1inch API key
ONE_INCH_API_KEY = ""

# USDC contract address on Base (checksummed)
usdc_address = w3.to_checksum_address("")

# Token ABI for balance, approval, and decimals
token_abi = json.loads('''
[
    {
        "constant": true,
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "type": "function"
    },
    {
        "constant": false,
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "value", "type": "uint256"}
        ],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "type": "function"
    }
]
''')

# Fjord Foundry presale ABI (simplified, includes redeem and saleToken)
fjord_abi = json.loads('''
[
    {
        "constant": false,
        "inputs": [],
        "name": "redeem",
        "outputs": [],
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "saleToken",
        "outputs": [{"name": "", "type": "address"}],
        "type": "function"
    }
]
''')

# Approve token spending
def approve_token(token_address, amount, spender):
    token_contract = w3.eth.contract(address=token_address, abi=token_abi)
    tx = token_contract.functions.approve(spender, amount).build_transaction({
        'from': wallet_address,
        'nonce': w3.eth.get_transaction_count(wallet_address),
        'gasPrice': w3.eth.gas_price
    })
    gas_estimate = w3.eth.estimate_gas(tx)
    tx['gas'] = int(gas_estimate * 1.2)
    balance = w3.eth.get_balance(wallet_address)
    gas_cost = tx['gas'] * tx['gasPrice']
    if balance < gas_cost:
        print(f"Insufficient ETH balance: {w3.from_wei(balance, 'ether')} ETH. Required: {w3.from_wei(gas_cost, 'ether')} ETH.")
        return False
    signed_tx = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    w3.eth.wait_for_transaction_receipt(tx_hash)
    print(f"Approval successful! Hash: {tx_hash.hex()}")
    return True

# Get token decimals
def get_token_decimals(token_address):
    token_contract = w3.eth.contract(address=token_address, abi=token_abi)
    try:
        return token_contract.functions.decimals().call()
    except Exception:
        return 18  # Default to 18 if call fails

# Buy tokens with USDC via 1inch
def buy_tokens(usdc_amount, slippage, token_address):
    token_address = w3.to_checksum_address(token_address)
    usdc_amount_wei = int(usdc_amount * 10**6)
    usdc_contract = w3.eth.contract(address=usdc_address, abi=token_abi)
    usdc_balance = usdc_contract.functions.balanceOf(wallet_address).call()
    if usdc_balance < usdc_amount_wei:
        print(f"Insufficient USDC balance: {usdc_balance / 10**6} USDC. Required: {usdc_amount} USDC.")
        return

    if not approve_token(usdc_address, usdc_amount_wei, ONE_INCH_ROUTER):
        return

    headers = {"Authorization": f"Bearer {ONE_INCH_API_KEY}"}
    params = {
        "fromTokenAddress": usdc_address,
        "toTokenAddress": token_address,
        "amount": str(usdc_amount_wei),
        "fromAddress": wallet_address,
        "slippage": str(slippage),
        "disableEstimate": "false"
    }
    response = requests.get(f"{ONE_INCH_API_BASE}/swap", headers=headers, params=params)
    if response.status_code != 200:
        error_data = response.json()
        if "description" in error_data:
            if "insufficient liquidity" in error_data["description"]:
                print(f"Insufficient liquidity for USDC/{token_address} swap on Base. No viable route found.")
            elif "Not enough allowance" in error_data["description"]:
                print(f"Allowance issue detected: {error_data['description']}. Approval may have failed.")
            else:
                print(f"1inch API error: {response.text}")
        else:
            print(f"1inch API error: {response.text}")
        return

    swap_data = response.json()
    if "dstAmount" not in swap_data:
        print("Error: 'dstAmount' not found in 1inch API response. Check API key, parameters, or liquidity.")
        return
    token_decimals = get_token_decimals(token_address)
    token_amount = int(swap_data["dstAmount"]) / 10**token_decimals

    tx = {
        "from": wallet_address,
        "to": ONE_INCH_ROUTER,
        "data": swap_data["tx"]["data"],
        "gasPrice": w3.eth.gas_price,
        "nonce": w3.eth.get_transaction_count(wallet_address),
        "value": int(swap_data["tx"]["value"])
    }
    gas_estimate = w3.eth.estimate_gas(tx)
    tx['gas'] = int(gas_estimate * 1.2)
    balance = w3.eth.get_balance(wallet_address)
    gas_cost = tx['gas'] * tx['gasPrice']
    if balance < gas_cost:
        print(f"Insufficient ETH balance: {w3.from_wei(balance, 'ether')} ETH. Required: {w3.from_wei(gas_cost, 'ether')} ETH.")
        return

    print(f"You will receive approximately {token_amount} tokens.")
    confirm = input("Confirm transaction? (yes/no): ").lower()
    if confirm == "yes":
        signed_tx = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        print(f"Transaction successful! Hash: {tx_hash.hex()}")
    else:
        print("Transaction cancelled.")

# Sell tokens for USDC via 1inch
def sell_tokens(percentage, slippage, token_address):
    token_address = w3.to_checksum_address(token_address)
    token_contract = w3.eth.contract(address=token_address, abi=token_abi)
    balance = token_contract.functions.balanceOf(wallet_address).call()
    amount_to_sell = int(balance * (percentage / 100))
    if amount_to_sell == 0:
        print("No tokens to sell or insufficient balance.")
        return

    if not approve_token(token_address, amount_to_sell, ONE_INCH_ROUTER):
        return

    headers = {"Authorization": f"Bearer {ONE_INCH_API_KEY}"}
    params = {
        "fromTokenAddress": token_address,
        "toTokenAddress": usdc_address,
        "amount": str(amount_to_sell),
        "fromAddress": wallet_address,
        "slippage": str(slippage),
        "disableEstimate": "false"
    }
    response = requests.get(f"{ONE_INCH_API_BASE}/swap", headers=headers, params=params)
    if response.status_code != 200:
        error_data = response.json()
        if "description" in error_data:
            if "insufficient liquidity" in error_data["description"]:
                print(f"Insufficient liquidity for {token_address}/USDC swap on Base. No viable route found.")
            elif "Not enough allowance" in error_data["description"]:
                print(f"Allowance issue detected: {error_data['description']}. Approval may have failed.")
            else:
                print(f"1inch API error: {response.text}")
        else:
            print(f"1inch API error: {response.text}")
        return

    swap_data = response.json()
    if "dstAmount" not in swap_data:
        print("Error: 'dstAmount' not found in 1inch API response. Check API key, parameters, or liquidity.")
        return
    usdc_amount = int(swap_data["dstAmount"]) / 10**6

    tx = {
        "from": wallet_address,
        "to": ONE_INCH_ROUTER,
        "data": swap_data["tx"]["data"],
        "gasPrice": w3.eth.gas_price,
        "nonce": w3.eth.get_transaction_count(wallet_address),
        "value": int(swap_data["tx"]["value"])
    }
    gas_estimate = w3.eth.estimate_gas(tx)
    tx["gas"] = int(gas_estimate * 1.2)
    balance = w3.eth.get_balance(wallet_address)
    gas_cost = tx["gas"] * tx["gasPrice"]
    if balance < gas_cost:
        print(f"Insufficient ETH balance: {w3.from_wei(balance, 'ether')} ETH. Required: {w3.from_wei(gas_cost, 'ether')} ETH.")
        return

    print(f"You will receive approximately {usdc_amount} USDC.")
    confirm = input("Confirm transaction? (yes/no): ").lower()
    if confirm == "yes":
        signed_tx = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        print(f"Transaction successful! Hash: {tx_hash.hex()}")
    else:
        print("Transaction cancelled.")

# Claim and sell tokens from Fjord Foundry presale
def claim_and_sell(presale_address, slippage):
    presale_address = w3.to_checksum_address(presale_address)
    presale_contract = w3.eth.contract(address=presale_address, abi=fjord_abi)

    # Simulate redeem call to check for revert
    try:
        presale_contract.functions.redeem().call({'from': wallet_address})
        print("Redeem simulation successful, proceeding with transaction...")
    except Exception as e:
        print(f"Simulation failed: {str(e)}")
        if hasattr(e, 'args') and len(e.args) > 0 and isinstance(e.args[0], dict):
            print(f"Revert reason: {e.args[0].get('message', 'Unknown')}")
        return

    # Claim tokens
    try:
        tx = presale_contract.functions.redeem().build_transaction({
            'from': wallet_address,
            'nonce': w3.eth.get_transaction_count(wallet_address),
            'gasPrice': w3.eth.gas_price
        })
        gas_estimate = w3.eth.estimate_gas(tx)
        tx['gas'] = int(gas_estimate * 1.2)
        balance = w3.eth.get_balance(wallet_address)
        gas_cost = tx['gas'] * tx['gasPrice']
        if balance < gas_cost:
            print(f"Insufficient ETH balance: {w3.from_wei(balance, 'ether')} ETH. Required: {w3.from_wei(gas_cost, 'ether')} ETH.")
            return
        signed_tx = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        print(f"Tokens claimed successfully! Hash: {tx_hash.hex()}")
    except Exception as e:
        print(f"Failed to claim tokens: {str(e)}")
        if hasattr(e, 'args') and len(e.args) > 0 and isinstance(e.args[0], dict):
            print(f"Revert reason: {e.args[0].get('message', 'Unknown')}")
        return

    # Get the token address from the presale contract
    try:
        token_address = presale_contract.functions.saleToken().call()
        print(f"Claimed token address: {token_address}")
    except Exception as e:
        print(f"Failed to get token address: {str(e)}")
        return

    # Sell 100% of the claimed tokens
    sell_tokens(100, slippage, token_address)

# Menu
def main_menu():
    while True:
        print("\nAerodrome Swap Menu (via 1inch Aggregator):")
        print("1. Buy Tokens with USDC")
        print("2. Sell Tokens for USDC")
        print("3. Claim and Sell from Fjord Presale")
        print("4. Exit")
        choice = input("Enter your choice (1-4): ")

        if choice == "1":
            usdc_amount = float(input("Enter USDC amount to spend: "))
            slippage = float(input("Enter slippage tolerance (%): "))
            token_address = input("Enter token contract address: ")
            if not w3.is_address(token_address):
                print("Invalid contract address!")
                continue
            buy_tokens(usdc_amount, slippage, token_address)

        elif choice == "2":
            percentage = float(input("Enter percentage of tokens to sell (0-100): "))
            if not 0 <= percentage <= 100:
                print("Invalid percentage!")
                continue
            slippage = float(input("Enter slippage tolerance (%): "))
            token_address = input("Enter token contract address: ")
            if not w3.is_address(token_address):
                print("Invalid contract address!")
                continue
            sell_tokens(percentage, slippage, token_address)

        elif choice == "3":
            presale_address = input("Enter presale contract address: ")
            if not w3.is_address(presale_address):
                print("Invalid presale contract address!")
                continue
            slippage = float(input("Enter slippage tolerance (%) for selling: "))
            claim_and_sell(presale_address, slippage)

        elif choice == "4":
            print("Exiting...")
            break

        else:
            print("Invalid choice! Please try again.")

if __name__ == "__main__":
    if not w3.is_connected():
        print("Failed to connect to the Base network!")
    else:
        print(f"Connected to Base network. Wallet: {wallet_address}")
        main_menu()
