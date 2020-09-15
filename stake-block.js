"use strict";

const { Block } = require('spartan-gold');

const TX_TYPE_STAKE = "STAKE";
const TX_TYPE_UNSTAKE = "UNSTAKE";
const TX_TYPE_EVIDENCE = "EVIDENCE";

const UNSTAKE_DELAY = 35;

module.exports = class StakeBlock extends Block {

  static get TX_TYPE_STAKE() { return TX_TYPE_STAKE; }
  static get TX_TYPE_UNSTAKE() { return TX_TYPE_UNSTAKE; }
  static get TX_TYPE_EVIDENCE() { return TX_TYPE_EVIDENCE; }

  constructor(rewardAddr, prevBlock, target, coinbaseReward) {
    super(rewardAddr, prevBlock, target, coinbaseReward);

    // Tracking current balances of locked gold:  clientID -> totalAmount
    this.stakeBalances = (prevBlock && prevBlock.stakeBalances) ? new Map(prevBlock.stakeBalances) : new Map();

    // Tracking when to unlock gold:  blockLocked -> [{ clientID, amount }]
    this.unstakingEvents = (prevBlock && prevBlock.unstakingEvents) ? new Map(prevBlock.unstakingEvents) : new Map();

    this.handleUnstakingEvents();
  }

  /**
   * After a fixed number of blocks have passed since the unstaking event,
   * staked gold becomes unstaked again.
   */
  handleUnstakingEvents() {
    // Updating locked gold balances if the locking time has elapsed.
    if (this.unstakingEvents.has(this.chainLength)) {
      let q = this.unstakingEvents.get(this.chainLength);
      q.forEach(({clientID, amount}) => {
        let totalStaked = this.stakeBalances.get(clientID);
        console.log(`Unstaking ${totalStaked} for ${clientID}`);
        this.stakeBalances.set(clientID, totalStaked - amount);
      });

      // No longer need to track these locking events.
      this.unstakingEvents.delete(this.chainLength);
    }

  }

  /**
   * This method extends the parent method with support for gold locking transactions.
   * 
   * @param {Transaction} tx - A locking transaction.
   * @param {StakeClient} client - Used for printing debug messages.
   * 
   * @returns Success of adding transaction to the block.
   */
  addTransaction(tx, client) {
    //console.log(`Adding tx: ${JSON.stringify(tx)}`);
    if (!super.addTransaction(tx, client)) return false;

    // For standard transactions, we don't need to do anything else.
    if (tx.data === undefined || tx.data.type === undefined) return;

    switch (tx.data.type) {
      case TX_TYPE_STAKE:
        this.stakeGold(tx.from, tx.data.amountStaked);
        break;
      case TX_TYPE_UNSTAKE:
        this.unstakeGold(tx.from, tx.data.amountToUnstake);
        break;
      case TX_TYPE_EVIDENCE:
        throw "Not implemented";
      default:
        throw new Error(`Unrecognized type: ${tx.data.type}`);
    }

    /*
    // Updating amount of staked gold, if there was any staking.
    if (tx.amountGoldLocked > 0) {
      let goldLocked = this.lockedGold(tx.from);
      this.stakeBalances.set(tx.from, goldLocked + tx.amountGoldLocked);

      // tracking when to unlock gold
      let unlockingRound = this.chainLength + LOCK_DURATION_ROUNDS;
      let q = this.unstakingEvents.get(unlockingRound) || [];
      q.push({clientID: tx.from, amount: tx.amountGoldLocked});
      this.unstakingEvents.set(unlockingRound, q);

      // Giving generated reward to outputs.
      if (tx.data.lockingOutputs) tx.data.lockingOutputs.forEach(({amount, address}) => {
        let receiverBalance = this.balances.get(address) || 0;
        let minted = LockingTransaction.goldGenerated(amount);
        this.balances.set(address, receiverBalance + minted);
      });
    }*/

    // Transaction added successfully.
    return true;
  }

  /**
   * Updates amount of gold staked for the specified address.
   * 
   * @param {*} addr - Address staking gold.
   * @param {number} amountStaked - Amount of gold staked by the validator.
   */
  stakeGold(addr, amountStaked) {
    let currentStake = this.amountGoldStaked(addr);
    this.stakeBalances.set(addr, currentStake + amountStaked);
  }

  unstakeGold(addr, amountUnstaked) {
    let unstakingRound = this.chainLength + UNSTAKE_DELAY;
    let q = this.unstakingEvents.get(unstakingRound) || [];
      q.push({clientID: addr, amount: amountUnstaked});
      this.unstakingEvents.set(unstakingRound, q);
  }

  amountGoldStaked(addr) {
    return this.stakeBalances.get(addr) || 0;
  }

  /**
   * When rerunning a locking block, we must also replaying any gold
   * staking/unstaking events.
   * 
   * @param {Block} prevBlock - The previous block in the blockchain, used for initial balances.
   * 
   * @returns {Boolean} - True if the block's transactions are all valid.
   */
  rerun(prevBlock) {
    // For coinLocking, we need to track locked funds and locking events as well.
    this.stakeBalances = new Map(prevBlock.stakeBalances);
    this.unstakingEvents = new Map(prevBlock.unstakingEvents);

    // Need to repeat any gold unstaking.
    this.handleUnstakingEvents();

    return super.rerun(prevBlock);
  }

};
