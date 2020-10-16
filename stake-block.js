"use strict";

const { Block } = require('spartan-gold');

const Proposal = require('./proposal.js');
const Vote = require('./vote.js');

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

    // Tracking power of validators (that is, priority for proposing blocks).
    this.accumPower = (prevBlock && prevBlock.accumPower) ? new Map(prevBlock.accumPower) : new Map();

    // Tracking punishments (so that we don't over punish for a mistake).
    //this.punishments = (prevBlock && prevBlock.punishments) ? new Set(prevBlock.punishments) : new Set();

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
    if (tx.data === undefined || tx.data.type === undefined) return true;

    switch (tx.data.type) {
      case TX_TYPE_STAKE:
        this.stakeGold(tx.from, tx.data.amountStaked);
        break;
      case TX_TYPE_UNSTAKE:
        this.unstakeGold(tx.from, tx.data.amountToUnstake);
        break;
      case TX_TYPE_EVIDENCE:
        this.punishCheater(tx.data.msg1, tx.data.msg2, client);
        break;
      default:
        throw new Error(`Unrecognized type: ${tx.data.type}`);
    }

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

  punishCheater(msg1, msg2, client) {

    // Proposals have a 'block' field, so distinguish between
    // votes and proposals by checking for its existence.
    if (msg1.block !== undefined) {
      msg1 = new Proposal(msg1);
      msg2 = new Proposal(msg2);
    } else {
      msg1 = new Vote(msg1);
      msg2 = new Vote(msg2);
    }

    //let punishmentID1 = msg1.id + '-' + msg2.id;
    //let punishmentID2 = msg2.id + '-' + msg1.id;
    //if (this.punishments.has(punishmentID1)) {
    //  // If the cheater has already been punished, don't punish them again.
    //  return;
    //} else {
    //  // Otherwise, record the punishment.
    //  this.punishments.add(punishmentID1);
    //  this.punishments.add(punishmentID2);
    //}

    // If the proposals are not duplicates, are from the same
    // validator, are for the same height and round, and have
    // valid signatures, they are evidence of Byzantine behavior.
    if (msg1.id !== msg2.id && msg1.from === msg2.from &&
        msg1.height === msg2.height && msg1.round === msg2.round &&
        msg1.hasValidSignature() && msg2.hasValidSignature()) {

      // Byzantine behavior results in the validator losing their stake,
      // which is redistributed amongst the other validators.
      // This seems to differ between v. 0.5 where all of the stake is
      // seized, and 0.6 where only 1/3 of the stake is seized.  We chose
      // to follow v. 0.5 for the sake of simplicity.
      let cheaterAddr = msg1.from;
      let balance = this.balanceOf(msg1.from);
      let stakeAmount = this.amountGoldStaked(cheaterAddr);

      // Ejecting the cheater from the validator set, and seizing their coins.
      this.accumPower.delete(cheaterAddr);
      this.stakeBalances.delete(cheaterAddr);
      this.unstakingEvents.delete(cheaterAddr);
      this.balances.set(cheaterAddr, balance - stakeAmount);

      // Dividing up rewards among other validators according to their stake.
      let totalBonded = this.getTotalStake();
      this.stakeBalances.forEach((amountStaked, addr) => {
        let b = this.balanceOf(addr);
        let proportion = amountStaked / totalBonded;
        let share = Math.floor(stakeAmount * proportion);
        this.balances.set(addr, b+share);
      });

      if (client) client.log(`Seizing ${stakeAmount} bonded coins from ${cheaterAddr}.`);
    }
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
    this.stakeBalances = new Map(prevBlock.stakeBalances);
    this.unstakingEvents = new Map(prevBlock.unstakingEvents);
    this.accumPower = new Map(prevBlock.accumPower);
    //this.punishments = new Set(prevBlock.punishments);

    // Updating the accumulated power for the block.
    this.updateAccumPower(this.rewardAddr);

    // Need to repeat any gold unstaking.
    this.handleUnstakingEvents();

    return super.rerun(prevBlock);
  }

  hasValidProof() {
    // FIXME: need to validate block.
    return true;
  }

  /**
   * This method implements Tendermint's approach for updating voting power,
   * following the algorithm described in Section 4.3 of the 0.5 version of
   * their paper.  (Note that the 0.6 version of their paper does not show
   * their round-robin algorithm).
   * 
   * @param proposerAddr - The address of the proposer who produced the block.
   */
  updateAccumPower(proposerAddr) {
    let totalBonded = 0;

    // We increase the voting power of each validator by the amount of
    // gold they have staked (or "bonded" by the terminology of their paper).
    this.stakeBalances.forEach((amountBonded, addr) => {
      let power = this.accumPower.get(addr) || 0;
      this.accumPower.set(addr, power + amountBonded);
      totalBonded += amountBonded;
    });

    // The block proposer's power is reduced by the total amount
    // of **all** gold bonded, do that the total amount of voting
    // power is unchanged.
    let currentPower = this.accumPower.get(proposerAddr);
    this.accumPower.set(proposerAddr, currentPower - totalBonded);
  }

  /**
   * Returns total amount of bonded coins currently in the block.
   */
  getTotalStake() {
    let totalStake = 0;
    this.stakeBalances.forEach((amountBonded) => {
      totalStake += amountBonded;
    });
    return totalStake;
  }
};
