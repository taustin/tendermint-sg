"use strict";

// Network simulation settings
const CHANCE_DROPPED_MSG = 0;
const MESSAGE_DELAY_RANGE = 0;

// Tendermint settings for delays.
const DELTA = 400;
const COMMIT_TIME = 2000;

const { Client, Transaction } = require('spartan-gold');

// Tendermint extensions
const Validator = require('./validator.js');
const StakeBlock = require('./stake-block.js');
const Blockchain = require('./stake-blockchain.js');

// Simulates problematic network conditions.
const UnreliableNet = require('./unreliable-net.js');
const ByzantineProposer = require('./byzantine-proposer.js');

console.log("Starting simulation.  This may take a moment...");

let fakeNet = new UnreliableNet(CHANCE_DROPPED_MSG, MESSAGE_DELAY_RANGE);

// Clients
let alice = new Client({name: "Alice", net: fakeNet});
let bob = new Client({name: "Bob", net: fakeNet});
let charlie = new Client({name: "Charlie", net: fakeNet});

// Validators
let minnie = new Validator({name: "Minnie", net: fakeNet});
let mickey = new Validator({name: "Mickey", net: fakeNet});
let goofy = new Validator({name: "Goofy", net: fakeNet});
let donald = new Validator({name: "Donald", net: fakeNet});

// Byzantine validators
let maleficent = new ByzantineProposer({name: "Maleficent", net: fakeNet});

// Creating genesis block
Blockchain.makeGenesis({
  blockClass: StakeBlock,
  transactionClass: Transaction,
  confirmedDepth: 3,
  delta: DELTA,
  commitTime: COMMIT_TIME,
  clientBalanceMap: new Map([
    [alice, 233],
    [bob, 99],
    [charlie, 67],
    [minnie, 400],
    [mickey, 300],
    [goofy,  200],
    [donald,  500],
    [maleficent,  500],
  ]),
  startingStakeMap: new Map([
    [minnie, 200],
    [mickey,  99],
    [goofy,   54],
    [maleficent,   80],
  ]),
});

function showBalances(client) {
  console.log(`Alice has ${client.lastBlock.balanceOf(alice.address)} gold.`);
  console.log(`Bob has ${client.lastBlock.balanceOf(bob.address)} gold.`);
  console.log(`Charlie has ${client.lastBlock.balanceOf(charlie.address)} gold.`);
  console.log(`Minnie has ${client.lastBlock.balanceOf(minnie.address)} gold.`);
  console.log(`Mickey has ${client.lastBlock.balanceOf(mickey.address)} gold.`);
  console.log(`Goofy has ${client.lastBlock.balanceOf(goofy.address)} gold.`);
  console.log(`Donald has ${client.lastBlock.balanceOf(donald.address)} gold.`);
  console.log(`Maleficent has ${client.lastBlock.balanceOf(maleficent.address)} gold.`);
}

// Showing the initial balances from Alice's perspective, for no particular reason.
console.log("Initial balances:");
showBalances(alice);

fakeNet.register(alice, bob, charlie, minnie, mickey, goofy, donald, maleficent);

// Miners start mining.
minnie.initialize();
mickey.initialize();
goofy.initialize();
maleficent.initialize();

// Alice transfers some money to Bob.
console.log(`Alice is transferring 40 gold to ${bob.address}`);
alice.postTransaction([{ amount: 40, address: bob.address }]);

//setTimeout(() => {
//  console.log();
//  console.log("***Starting a late-to-the-party validator***");
//  console.log();
//  fakeNet.register(donald);
//  donald.postStakingTransaction(300);
//  setTimeout(() => donald.initialize(), 1000);
//}, 4000);

// Print out the final balances after it has been running for some time.
let foo = () => {

  if (minnie.currentBlock.chainLength < 10) {
    setTimeout(foo, 1000);
    return;
  }

  console.log();
  console.log(`Minnie has a chain of length ${minnie.currentBlock.chainLength}:`);

  console.log();
  console.log(`Mickey has a chain of length ${mickey.currentBlock.chainLength}:`);

  //console.log();
  //console.log(`Donald has a chain of length ${donald.currentBlock.chainLength}:`);

  console.log();
  console.log("Final balances (Minnie's perspective):");
  showBalances(minnie);

  console.log();
  console.log("Final balances (Alice's perspective):");
  showBalances(alice);

  //console.log();
  //console.log("Final balances (Donald's perspective):");
  //showBalances(donald);

  process.exit(0);
};

setTimeout(foo, 10000);
