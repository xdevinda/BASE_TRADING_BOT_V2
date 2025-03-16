//Update Packages:

sudo apt update && sudo apt upgrade -y

//Install Node.js and npm:

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

//Verify installation:

node -v  # Should show v20.x.x
npm -v   # Should show a version like 10.x.x


//Initialize Node.js Project:Create a package.json file

npm init -y


//Install Dependencies:

npm install ethers@6.13.5 dotenv


//Create constants.js:

nano constants.js


//Create utils.js:

nano utils.js

//Create index.js

nano index.js

//Create .env File:

nano .env 
-->> 
PRIVATE_KEY=//Private key here//
MNEMONIC=//seed phrase here//

//Run the bot:

node index.js

