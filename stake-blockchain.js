"use strict";

const { Blockchain } = require('spartan-gold');

const BLOCK_PROPOSAL = "BLOCK_PROPOSAL";
const PREVOTE = "PREVOTE";

module.exports = class StakeBlockchain extends Blockchain {
  static get BLOCK_PROPOSAL() { return BLOCK_PROPOSAL; }
  static get PREVOTE() { return PREVOTE; }

  static makeGenesis(cfg) {
    // Generating the default genesis block from the parent
    let genesis = Blockchain.makeGenesis(cfg);

    // Either startingStake or startingStakeMap must be specified, but not both.
    if (cfg.startingStake === undefined && cfg.startingStakeMap === undefined) {
      throw new Error("Either startingStake or startingStakeMap must be specified.");
    } else if (cfg.startingStake !== undefined && cfg.startingStakeMap !== undefined) {
      throw new Error("Either startingStake or startingStakeMap must be specified, but both.");
    }

    let startingStake = cfg.startingStake || {};

    if (cfg.startingStakeMap !== undefined) {
      for (let [client, stake] of cfg.startingStakeMap.entries()) {
        startingStake[client.address] = stake;
      }
    }

    // Initializing starting stake and accumulated power in the genesis block.
    Object.keys(startingStake).forEach((addr) => {
      genesis.stakeBalances.set(addr, startingStake[addr]);
      genesis.accumPower.set(addr, startingStake[addr]);
    });

    return genesis;
  }
};
