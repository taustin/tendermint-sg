"use strict";

const Blockchain = require('./blockchain.js');
const Client = require('./client.js');
const StakeBlock = require('./stake-block.js');

module.exports = class StakeClient extends Client {

  constructor(...args) {
    super(...args);
  }

  postStakingTransaction(stakeAmount, fee=Blockchain.DEFAULT_TX_LOCK_FEE) {
    let totalPayments = stakeAmount + fee;

    // Make sure the client has enough gold.
    if (totalPayments > this.availableGold) {
      throw new Error(`Requested ${totalPayments}, but account only has ${this.availableGold} available.`);
    }

    // Broadcasting the new transaction.
    let tx = Blockchain.makeTransaction({
      from: this.address,
      nonce: this.nonce,
      pubKey: this.keyPair.public,
      outputs: [],
      fee: fee,
      data: {
        type: StakeBlock.TX_TYPE_STAKE,
        amountStaked: stakeAmount
      },
    });

    tx.sign(this.keyPair.private);

    // Adding transaction to pending.
    this.pendingOutgoingTransactions.set(tx.id, tx);

    this.nonce++;

    this.log(`Posting transaction ${tx.id}`);

    this.net.broadcast(Blockchain.POST_TRANSACTION, tx);

    return tx;
  }

  postUnstakingTransaction(amountToUnstake, fee=Blockchain.DEFAULT_TX_LOCK_FEE) {
    // Make sure the client has enough gold.
    if (fee > this.availableGold) {
      throw new Error(`Requested ${fee}, but account only has ${this.availableGold} available.`);
    }

    // Broadcasting the new transaction.
    let tx = Blockchain.makeTransaction({
      from: this.address,
      nonce: this.nonce,
      pubKey: this.keyPair.public,
      outputs: [],
      fee: fee,
      data: {
        type: StakeBlock.TX_TYPE_UNSTAKE,
        amountToUnstake: amountToUnstake
      },
    });

    tx.sign(this.keyPair.private);

    // Adding transaction to pending.
    this.pendingOutgoingTransactions.set(tx.id, tx);

    this.nonce++;

    this.log(`Posting transaction ${tx.id}`);

    this.net.broadcast(Blockchain.POST_TRANSACTION, tx);

    return tx;
  }

  /**
   * In addition to the usual issues with determining what gold is available,
   * with the coin-locking model we must also consider how much gold is
   * currently locked.
   */
  get availableGold() {
    return super.availableGold - this.amountGoldStaked();
  }

  /**
   * Returns the amount of gold currently locked.
   */
  amountGoldStaked() {
    return this.lastConfirmedBlock.amountGoldStaked(this.address);
  }

  /**
   * Utility method that displays all confimed balances for all clients,
   * according to the client's own perspective of the network.
   */
  showAllBalances() {
    this.log("Showing balances:");
    for (let [id,balance] of this.lastConfirmedBlock.balances) {
      console.log(`    ${id}: ${balance} (${this.lastConfirmedBlock.amountGoldStaked(id)} staked)`);
    }
  }
};
