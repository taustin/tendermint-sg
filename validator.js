"use strict";

const { Miner } = require('spartan-gold');

const Proposal = require('./proposal.js');
const StakeBlockchain = require('./stake-blockchain.js');
const StakeMixin = require('./stake-mixin.js');
const Vote = require('./vote.js');

// Step delta for each step of a round.
const DELTA = 300;

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
    this.on(StakeBlockchain.NEW_ROUND, this.newRound);
    this.on(StakeBlockchain.BLOCK_PROPOSAL, this.collectProposal);
    this.on(StakeBlockchain.PREVOTE, this.collectPrevote);
    this.on(StakeBlockchain.PRECOMMIT, this.collectPrecommit);

    // Collection buckets for proposals and blocks.
    this.proposals = [];
    this.proposedBlocks = {};

    // Tracking votes
    this.prevotes = {};
    this.precommits = {};

    // Start block production
    setTimeout(() => this.emit(StakeBlockchain.NEW_ROUND, 0));

  }

  /**
   * In addition to other responsibilities related to searching for a new block,
   * the accumulated power must be copied over for the round.
   */
  startNewSearch(...args) {
    super.startNewSearch(...args);
    this.roundAccumPower = new Map(this.currentBlock.accumPower);

    // Tracking height/round for the proposal.
    this.height = this.currentBlock.chainLength;
    this.round = 0;

    // Remove any locks from the previous height.
    delete this.lockedBlock;
  }

  get availableGold() {
    return super.availableGold - this.amountGoldStaked();
  }

  /**
   * Verifies that a vote is valid and stores it in the ballotBox
   * if it is.  If there is Byzantine behavior, an exception will
   * be raised.
   * 
   * @param {Vote} vote - A vote of whatever kind.
   * @param {Object} ballotBox - The collection of votes.
   */
  verifyAndVote(vote, ballotBox) {
    vote = new Vote(vote);
    if (!vote.isValid(this)) {
      return;
    }

    // Check for Byzantine votes
    if (ballotBox[vote.from]) {
      let currentVote = ballotBox[vote.from];
      if (currentVote.id !== vote.id) {
        throw new Error(`
          Possible Byzantine behavior by ${vote.from}.
          Received conflicting votes:
          -> ${JSON.stringify(currentVote)}
          -> ${JSON.stringify(vote)}`);
      }
    } else {
      // Otherwise, store the validator's vote.
      ballotBox[vote.from] = vote;
    }
  }

  /**
   * This method counts the number of votes for a specified block,
   * where the keys identify the blocks and the values represent
   * the total number of votes (amount of stake) for that block.
   * 
   * @param {Object} ballotBox - Collection of votes, blockID -> amount votes.
   * 
   * @returns ID of the winning block.
   */
  countVotes(ballotBox) {
    let totalStake = this.currentBlock.getTotalStake();
    let votesNeeded = 2 * totalStake / 3;

    let candidateBlocks = {};

    let winningBlockID = undefined;

    Object.keys(ballotBox).forEach((voterAddr) => {
      let stake = this.currentBlock.amountGoldStaked(voterAddr);
      let vote = ballotBox[voterAddr];
      let blockID = vote.blockID;
      let currentVotes = candidateBlocks[blockID] || 0;
      currentVotes += stake;
      candidateBlocks[blockID] = currentVotes;
      this.log(`Block ${blockID} has ${currentVotes} votes out of ${totalStake}.`);
      if (currentVotes > votesNeeded) {
        if (blockID === StakeBlockchain.NIL) {
          winningBlockID = StakeBlockchain.NIL;
        } else {
          winningBlockID = vote.blockID;
        }
      }
    });

    return winningBlockID;
  }

  /**
   * Start a new round to find a block.
   */
  newRound() {
    // Update the round count.
    this.round++;

    this.determineProposer();

    // If the validator is the proposer, propose a block.
    if (this.address === this.currentProposer) {
      // If it previously locked on to a block, share it.
      if (this.lockedBlock !== undefined) {
        this.shareProposal(this.lockedBlock);
      } else {
        this.proposeBlock();
      }
    }

    // We wait to collect proposals before we choose one.
    setTimeout(() => this.prevote(), this.round*DELTA);
  }

  /**
   * Determines the block proposer based on their "accumulated power".
   * It uses a weighted round-robin algorithm where validators with
   * more stake propose blocks more often.
   */
  determineProposer() {
    let proposerPower = 0;
    this.roundAccumPower.forEach((power, addr) => {
      this.log(`   ${addr} has ${power} (${typeof power}) voting power.`);
      if (power > proposerPower) {
        this.currentProposer = addr;
        proposerPower = power;
      }
    });
    this.log(`The block proposer is ${this.currentProposer}`);
  }

  proposeBlock() {
    // If proposer, make a proposal.  A proposal includes:
    // *the block height (in block)
    // *the round (done)
    // *signature (done)
    // *"proof-of-lock" if locked onto a block from a previous round
    this.currentBlock = StakeBlockchain.makeBlock(this.address, this.lastBlock);

    this.log(`Proposing block ${this.currentBlock.id} for round ${this.currentBlock.chainLength}-${this.round}.`);

    // FIXME: This should be only once per block height,
    //  but should be done every round for roundAccumPower
    this.currentBlock.updateAccumPower(this.address);

    this.shareProposal(this.currentBlock);
  }

  shareProposal(block) {
    let proposal = new Proposal({
      from: this.address,
      block: block,
      blockID: block.id,
      height: this.height,
      round: this.round,
      pubKey: this.keyPair.public,
    });

    proposal.sign(this.keyPair.private);

    this.net.broadcast(StakeBlockchain.BLOCK_PROPOSAL, proposal);
  }

  /**
   * This method collects proposals until the wall time.
   * It also stores the proposed block for later use.
   * 
   * @param {Proposal} proposal - A proposal for a new block, along with some metadata.
   */
  collectProposal(proposal) {
    this.proposals.push(new Proposal(proposal));
    let block = this.proposals.block;
    this.proposedBlocks[proposal.blockID] = block;
  }

  /**
   * Prevote for a proposal, by the following rules:
   * 1) If locked on to a previous block, vote for the locked block.
   * 2) Otherwise, if a valid proposal is received, vote for the new block.
   * 3) Otherwise vote NIL.
   * 
   * This method should also check for conflicting proposals from the block proposer.
   */
  prevote() {
    let vote = undefined;

    // If locked on to a vote, stick with it.
    if (this.lockedBlock !== undefined) {
      vote = Vote.makeVote(this, StakeBlockchain.PREVOTE, this.lockedBlock);

    } else {
      // Otherwise, go through all proposals and select the best one.
      let bestProposal = undefined;
      this.proposals.forEach((proposal) => {
        if (proposal.isValid(this)) {
          // We should not receive 2 valid proposals in a round,
          // unless they are duplicates or the proposer is Byzantine.
          if (bestProposal !== undefined) {
            if (bestProposal.blockID !== proposal.blockID) {
              throw new Error(`
                Possible Byzantine behavior by ${proposal.from}.
                Received conflicting blocks:
                -> ${bestProposal.blockID}
                -> ${proposal.blockID}`);
            }
          } else {
            bestProposal = proposal;
          }
        }
      });

      if (bestProposal === undefined) {
        // No valid proposal received -- vote NIL
        vote = Vote.makeNilVote(this, StakeBlockchain.PREVOTE);
      } else {
        // Otherwise, vote for the best received.
        vote = Vote.makeVote(this, StakeBlockchain.PREVOTE, bestProposal.blockID);
      }
    }

    this.log(`Voting for block ${vote.blockID}`);

    // Clearing out proposals and sharing vote.
    this.proposals = [];
    this.net.broadcast(StakeBlockchain.PREVOTE, vote);

    // After voting, set timer before determining precommit.
    setTimeout(() => this.precommit(), this.round*DELTA);
  }

  /**
   * Validates prevote, saving it if it is a valid vote.
   * This step will also catch any attempts to double-vote.
   * 
   * @param {Vote} vote - incoming vote.
   */
  collectPrevote(vote) {
    this.verifyAndVote(vote, this.prevotes);
  }

  /**
   * Precommit to a block, by the following rules.
   * 
   * 1) If a block gains 2/3 votes, lock on that block and broadcast precommit.
   *   Move on to the commit phase.
   * 
   * 2) If NIL gains 2/3 votes, release any locks.  Start a new round.
   * 
   * 3) If no 2/3 majority is reached do nothing.  Start a now round.
   */
  precommit() {
    let winningBlockID = this.countVotes(this.prevotes);
    this.prevotes = {};

    if (winningBlockID === undefined) {
      this.log(`Failed to reach 2/3 majority needed for precommit at height ${this.height}, round ${this.round}.`);
      setTimeout(() => this.emit(StakeBlockchain.NEW_ROUND, 0));
      return;
    }
    
    //****FIXME: Need to make a proof-of-lock for both block consensus
    // or for NIL consensus.

    if (winningBlockID === StakeBlockchain.NIL) {
      // If we receive 2/3 NIL votes, release any locks.
      delete this.lockedBlock;
      setTimeout(() => this.emit(StakeBlockchain.NEW_ROUND, 0));
      return;
    }
    
    // There is some ambiguity between Tendermint 0.5 and 0.6.  TM 0.5
    // indicates that a validator locks on to a **proposal**.  TM 0.6 instead
    // states that a validator locks on to a **block**.  We follow the latter.
    this.log(`Block ${winningBlockID} has more than 2/3 votes and is the winner`);
    this.lockedBlock = this.proposedBlocks[winningBlockID];
    
    // Broadcasting successful precommit.
    let vote = Vote.makeVote(this, StakeBlockchain.PRECOMMIT, winningBlockID);
    this.net.broadcast(StakeBlockchain.PRECOMMIT, vote);

    // Setting timer for commit step.
    setTimeout(() => this.commit(), this.round*DELTA);
  }


  collectPrecommit(precommit) {
    this.verifyAndVote(precommit, this.precommits);
  }

  commit() {
    let winningBlockID = this.countVotes(this.precommits);
    this.precommits = {};

    // 1) GET BLOCK (Do without waiting?)

    // 2) ONCE BLOCK IS RECEIVED, BROADCAST COMMIT. (Do without waiting?)

    // 3) ONCE 2/3 COMMITS RECEIVED, move on to newHeight

    // For now, if proposal is signed by the proposer, accept the block
    // and progress after a 1 second delay.
    if (this.currentProposer === this.address) {
      this.log("Announcing block");
      delete this.lockedBlock;
      //this.proposedBlocks = {};
      this.announceProof();
    }

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
