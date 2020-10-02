"use strict";

const { Miner, utils } = require('spartan-gold');

const StakeBlockchain = require('./stake-blockchain.js');
const StakeMixin = require('./stake-mixin.js');

module.exports = class Validator extends Miner {

  constructor(...args) {
    super(...args);

    // Mixing in common methods/properties for clients and validators.
    Object.assign(this, StakeMixin);
  }

  setGenesisBlock(genesis) {
    super.setGenesisBlock(genesis);
  }

  /**
   * Starts listeners and begins block production.
   */
  initialize() {
    this.startNewSearch();

    this.on(StakeBlockchain.POST_TRANSACTION, this.addTransaction);

    // Tendermint listeners.
    this.on(StakeBlockchain.NEW_ROUND, this.oneRound);
    this.on(StakeBlockchain.BLOCK_PROPOSAL, this.prevote);
    this.on(StakeBlockchain.PREVOTE, this.precommit);

    // Start block production
    setTimeout(() => this.emit(StakeBlockchain.NEW_ROUND, 0));
  }

  get availableGold() {
    return super.availableGold - this.amountGoldStaked();
  }

  oneRound(round) {
    // 1. propose
    this.determineProposer();
    if (this.address === this.currentProposer) {
      this.proposeBlock(round);
    }
        // 2. prevote
    // 3. precommit

    // If at the end of the round we have < 2/3 votes, we do another round.

    // If we have > 2/3 votes, we commit
  }

  determineProposer() {
    //let validatorList = Array.from(this.currentBlock.accumPower.keys());
    //this.log(`Validators: ${JSON.stringify(validatorList)}`);
    //this.currentProposer = validatorList[this.currentProposerCounter];
    //this.currentProposerCounter = (this.currentProposerCounter + 1) % validatorList.length;
    let proposerPower = 0;
    this.currentBlock.accumPower.forEach((power, addr) => {
      this.log(`   ${addr} has ${power} (${typeof power}) voting power.`);
      if (power > proposerPower) {
        this.currentProposer = addr;
        proposerPower = power;
      }
    });
    this.log(`The block proposer is ${this.currentProposer}`);
  }

  proposeBlock(round) {
    // If proposer, make a proposal.  A proposal includes:
    // *the block height (in block)
    // *the round (done)
    // *signature (done)
    // *"proof-of-lock" if locked onto a block from a previous round
    this.log(`Proposing block for round ${this.currentBlock.chainLength}-${round}.`);
    this.currentBlock = StakeBlockchain.makeBlock(this.address, this.lastBlock);
    this.currentBlock.updateAccumPower(this.address);
    let msg = {
      from: this.address,
      block: this.currentBlock,
      round: round,
      sig: utils.sign(this.keyPair.private, this.currentBlock.id),
    };
    setTimeout(() => this.net.broadcast(StakeBlockchain.BLOCK_PROPOSAL, msg), 300);
  }

  prevote(proposal) {
    // For now, if proposal is signed by the proposer, accept the block
    // and progress after a 1 second delay.
    if (proposal.from !== this.currentProposer) {
      throw new Error(`Expecting proposal from ${this.currentProposer}, but received one from ${proposal.address}.`);
    }

    this.log(`Accepting proposal from ${proposal.from}`);
    
    if (this.currentProposer === this.address) {
      this.log("Announcing block");
      this.announceProof();
    }


    /*
    // FIXME: handle nil prevotes.
    let msg = {
      from: this.address,
      block: proposal,
    };

    // If locked on a proposed block from a previous round,
    // sign and broadcast a prevote.
    if (this.lockedProposal !== undefined) {
      msg.block = this.lockedProposal;
    }
    // Otherwise, if validator has received an acceptable proposal,
    // sign and broadcast a prevote for that proposal.
    else {
      // FIXME: check signature, validity of block, etc.
      msg.block = proposal;
    }

    // Sign and broadcast the prevote.
    msg.sig = utils.sign(this.keyPair.private, msg.block);
    this.net.broadcast(StakeBlockchain.PREVOTE, msg);
    */
  }

  precommit() {
    // If the validator has received > 2/3 prevotes for block proposal:
    // 1. Signs and broadcasts a precommit
    // 2. Locks onto block proposal (releasing any other locks)
    // 3. Produces proof-of-lock from all prevotes for this block

    // If the validator has received > 2/3 nil prevotes for block proposal:
    // 1. Releases any locks.
    // 2. Produces proof-of-lock from all nil prevotes
  }

  commit() {
    // If the validator does not have the block, it needs to get it from another validator.

    // Next, it signs and broadcasts its commit to the block.

    // Once 2/3 commits are received, validator sets its commitTime
    // and transitions to newHight.
  }

  newHeight() {
    // Gather additional commits before starting new round.
  }

  receiveBlock(...args) {
    this.log("Receiving block");
    super.receiveBlock(...args);
    this.log("Starting new round");
    this.startNewSearch();

    this.emit(StakeBlockchain.NEW_ROUND);
  }

};
