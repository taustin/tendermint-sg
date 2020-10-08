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
    // Storing transactions for next block.
    this.transactions = new Set();

    this.startNewSearch();

    this.on(StakeBlockchain.POST_TRANSACTION, this.addTransaction);

    // Listeners to collect proposals and votes.
    this.on(StakeBlockchain.BLOCK_PROPOSAL, this.collectProposal);
    this.on(StakeBlockchain.PREVOTE, this.collectPrevote);
    this.on(StakeBlockchain.PRECOMMIT, this.collectPrecommit);
    this.on(StakeBlockchain.COMMIT, this.collectCommit);

    // Collection buckets for proposals and blocks.
    this.proposals = [];
    this.proposedBlocks = {};

    // Tracking votes
    this.prevotes = {};
    this.precommits = {};
    this.commits = {};

    // Start block production
    setTimeout(() => this.newRound(), 0);

  }

  /**
   * In addition to other responsibilities related to searching for a new block,
   * the accumulated power must be copied over for the round.
   */
  startNewSearch() {
    super.startNewSearch();
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
      //this.log(`   ${addr} has ${power} (${typeof power}) voting power.`);
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

    // Add queued-up transactions to block.
    this.transactions.forEach((tx) => {
      this.currentBlock.addTransaction(tx, this);
    });
    this.transactions.clear();

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
    let block = StakeBlockchain.deserializeBlock(proposal.block);

    // If we don't have the previous block, we don't accept the block.
    // Fetching the missing blocks will be triggered if the block is
    // actually accepted.
    let prevBlock = this.blocks.get(block.prevBlockHash);
    if (prevBlock === undefined) return;

    // Otherwise, we rerun the block to update balances/etc. and store it.
    block.rerun(prevBlock);
    this.proposedBlocks[proposal.blockID] = block;
  }

  /**
   * Prevote for a proposal, by the following rules:
   * 
   * 1) If locked on to a previous block, vote for the locked block.
   * 
   * 2) Otherwise, if a valid proposal is received, vote for the new block.
   * 
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
   * 2) If NIL gains 2/3 votes, release any locks.
   * 
   * 3) If no 2/3 majority is reached do nothing.
   */
  precommit() {
    let winningBlockID = this.countVotes(this.prevotes);
    this.prevotes = {};

    //****FIXME: Need to make a proof-of-lock for both block consensus
    // or for NIL consensus.

    if (winningBlockID === undefined) {
      this.log(`Failed to reach 2/3 majority needed for precommit at height ${this.height}, round ${this.round}.`);
    } else if (winningBlockID === StakeBlockchain.NIL) {
      // If we receive 2/3 NIL votes, release any locks.
      delete this.lockedBlock;
    } else {
      // There is some ambiguity between Tendermint 0.5 and 0.6.  TM 0.5
      // indicates that a validator locks on to a **proposal**.  TM 0.6 instead
      // states that a validator locks on to a **block**.  We follow the latter.
      this.log(`Block ${winningBlockID} has more than 2/3 votes and is the winner`);
      this.lockedBlock = this.proposedBlocks[winningBlockID];
    
      // Broadcasting successful precommit.
      let vote = Vote.makeVote(this, StakeBlockchain.PRECOMMIT, winningBlockID);
      this.net.broadcast(StakeBlockchain.PRECOMMIT, vote);
    }

    // Setting to decide on whether to commit.
    setTimeout(() => this.commitDecision(), this.round*DELTA);
  }

  /**
   * Validates precommit vote, saving it if it is a valid vote.
   * This step will also catch any attempts to double-vote.
   * 
   * @param {Vote} vote - incoming vote.
   */
  collectPrecommit(precommit) {
    this.verifyAndVote(precommit, this.precommits);
  }

  /**
   * If 2/3 precommits are received, the validator commits.
   * Otherwise, it begins a new round.
   */
  commitDecision() {
    let winningBlockID = this.countVotes(this.precommits);
    this.precommits = {};

    if (winningBlockID === undefined || winningBlockID === StakeBlockchain.NIL) {
      setTimeout(() => this.newRound(), 0);
    } else {
      this.commit(winningBlockID);
    }
  }

  /**
   * The Tendermint papers differ on how the commit stage works.
   * As soon as the validator receives 2/3 precommits:
   * 
   * 1) Get the block if the validator does not already have it.
   * 
   * 2) Once the validator has the block, broadcast a commit.
   */
  commit(winningBlockID) {
    // **FIXME** Handle case where block is not available.

    this.nextBlock = this.proposedBlocks[winningBlockID];

    let vote = Vote.makeVote(this, StakeBlockchain.COMMIT, winningBlockID);
    this.net.broadcast(StakeBlockchain.COMMIT, vote);

    setTimeout(() => this.finalizeCommit(), DELTA);
  }

  /**
   * Validates commit vote, saving it if it is a valid vote.
   * This step will also catch any attempts to double-vote.
   * 
   * @param {Vote} vote - incoming vote.
   */
  collectCommit(commit) {
    this.verifyAndVote(commit, this.commits);
  }

  finalizeCommit() {
    let winningBlockID = this.countVotes(this.commits);

    if (winningBlockID === undefined) {
      // If we have less than 2/3 commits, wait longer.
      this.log(`No consensus on ${this.nextBlock.id} yet.  Waiting...`);
      setTimeout(() => this.finalizeCommit(), DELTA);
    } else {
      // **FIXME** ONCE 2/3 COMMITS RECEIVED, move on to newHeight (CHange timeout value)
      setTimeout(() => this.newHeight(), DELTA);

    }
  }

  newHeight() {
    // **FIXME** Gather up signatures.

    // Announce new block.
    this.currentBlock = this.nextBlock;
    this.announceProof();
    //if (this.address === this.currentProposer) {
    //  this.announceProof();
    //}

    // Reset details
    this.commits = {};
    delete this.nextBlock;
    delete this.lockedBlock;
    this.round = 0;

    // Start working on the next block.
    //this.receiveBlock(this.currentBlock);
    setTimeout(() => {
      this.startNewSearch();
      this.newRound();
    }, 0);
  }

  //*
  receiveBlock(...args) {
    this.log("Receiving block");
    super.receiveBlock(...args);
    //this.log("Starting new round");

    //setTimeout(() => this.newRound(), 0);
  }
  //*/

  addTransaction(tx) {
    this.log(`Storing transaction ${tx.id} for next block`);
    //return super.addTransaction(tx)
    tx = StakeBlockchain.makeTransaction(tx);
    this.transactions.add(tx);
  }

};
