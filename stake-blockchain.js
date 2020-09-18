"use strict";

const { Blockchain } = require('spartan-gold');

module.exports = class StakeBlockchain extends Blockchain {
  static makeGenesis(cfg) {
    // Generating the default genesis block from the parent
    let genesis = Blockchain.makeGenesis(cfg);

    let startingStake = cfg.startingStake;

     // Initializing starting stake in the genesis block.
     Object.keys(startingStake).forEach((addr) => {
      genesis.stakeBalances.set(addr, startingStake[addr]);
    });

    return genesis;
  }
};
