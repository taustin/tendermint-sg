"use strict";

const { Miner } = require('spartan-gold');

const StakeClient = require('./stake-client.js');

module.exports = class Validator extends Miner {
  constructor(...args) {
    super(...args);

    // Adding methods from StakeClient
    this.showAllBalances = StakeClient.prototype.showAllBalances;
    this.amountGoldStaked = StakeClient.prototype.amountGoldStaked;
    this._pst = StakeClient.prototype.postStakingTransaction;
    this._put = StakeClient.prototype.postUnstakingTransaction;
  }

  get availableGold() {
    return super.availableGold - this.amountGoldStaked();
  }

  postStakingTransaction(...args) {
    let tx = this._pst(...args);
    this.addTransaction(tx);
  }

  postUnstakingTransaction(...args) {
    let tx = this._put(...args);
    this.addTransaction(tx);
  }

  determineProposer() {
  }

  /**
   * If the block proposer, the validator sends out a block including
   * the proposer's signature to all other validators.
   */
  propose() {

  }

  /**
   * Once a validator has received 2/3
   */
  vote() {

  }

  sign() {

  }
};
