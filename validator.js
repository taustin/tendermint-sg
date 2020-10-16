"use strict";

const { Miner } = require('spartan-gold');

const Proposal = require('./proposal.js');
const StakeBlock = require('./stake-block.js');
const StakeBlockchain = require('./stake-blockchain.js');
const StakeMixin = require('./stake-mixin.js');
const Vote = require('./vote.js');

module.exports = class Validator extends Miner {

  constructor(...args) {
    super(...args);

    // Mixing in common methods/properties for clients and validators.
    Object.assign(this, StakeMixin);

    // Storing transactions for next block.
    this.transactions = new Set();
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
    //delete this.lockedBlock;
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
    out: if (ballotBox[vote.from] !== undefined) {
      let currentVote = ballotBox[vote.from];

      if (vote.fresherThan(currentVote)) {
        // Replace stale vote with new one.
        break out;
      } else if (currentVote.fresherThan(vote)) {
        // Ignore a stale vote.
        return;
      }

      if (currentVote.id === vote.id) {
        // If vote is a duplicate, just ignore it.
        return;
      } else {
        this.postEvidenceTransaction(vote.from, currentVote, vote);
      }
    }

    // If we made it here, store the validator's vote.
    ballotBox[vote.from] = vote;
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

      // Ignore stale votes (unless they are commits)
      if (vote.isStale(this.height, this.round)) {
        return;
      }

      let blockID = vote.blockID;
      let currentVotes = candidateBlocks[blockID] || 0;
      currentVotes += stake;
      candidateBlocks[blockID] = currentVotes;
      //this.log(`...${vote.from} votes for ${blockID} (${this.height}-${this.round}) with ${stake} votes`);
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
    // If we have committed to a block, we don't do any more rounds
    // until we reach a new height.
    if (this.nextBlock !== undefined) return;

    // Update the round count.
    this.round++;

    // According to TM v. 0.6, commits for older rounds
    // are automatically counted as prevotes and precommits for
    // all subsequent rounds.
    Object.keys(this.commits).forEach((voterAddr) => {
      this.log(`Copying over vote for ${voterAddr}`);
      let commit = this.commits[voterAddr];
      this.prevotes[voterAddr] = commit;
      this.precommits[voterAddr] = commit;
    });

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
    setTimeout(() => this.prevote(), this.round*StakeBlockchain.DELTA);
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
    this.log(`The block proposer for ${this.height}-${this.round} is ${this.currentProposer}`);
    this.updateRoundAccumPower(this.currentProposer);
  }

  /**
   * Updates power for the round.
   * 
   * @param proposerAddr - Address of wining proposer
   */
  updateRoundAccumPower(proposerAddr) {
    // FIXME: Need to merge with Block.updateAccumPower.

    let totalBonded = 0;

    // We increase the voting power of each validator by the amount of
    // gold they have staked (or "bonded" by the terminology of their paper).
    this.currentBlock.stakeBalances.forEach((amountBonded, addr) => {
      let power = this.roundAccumPower.get(addr) || 0;
      this.roundAccumPower.set(addr, power + amountBonded);
      totalBonded += amountBonded;
    });

    // The block proposer's power is reduced by the total amount
    // of **all** gold bonded, do that the total amount of voting
    // power is unchanged.
    let currentPower = this.roundAccumPower.get(proposerAddr);
    this.roundAccumPower.set(proposerAddr, currentPower - totalBonded);
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
      vote = Vote.makeVote(this, StakeBlockchain.PREVOTE, this.lockedBlock.id);

    } else {
      // Otherwise, go through all proposals and select the best one.
      let bestProposal = undefined;
      this.proposals.forEach((proposal) => {
        if (proposal.isValid(this)) {
          // We should not receive 2 valid proposals in a round,
          // unless they are duplicates or the proposer is Byzantine.
          if (bestProposal !== undefined) {
            if (bestProposal.blockID === proposal.blockID) {
              // Ignore duplicates
              return;
            } else {
              this.postEvidenceTransaction(proposal.from, bestProposal, proposal);
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

    //this.log(`Voting for block ${vote.blockID}`);

    // Clearing out proposals and sharing vote.
    this.proposals = [];
    this.net.broadcast(StakeBlockchain.PREVOTE, vote);

    // After voting, set timer before determining precommit.
    setTimeout(() => this.precommit(), this.round*StakeBlockchain.DELTA);
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
      //this.log(`Failed to reach 2/3 majority needed for precommit at height ${this.height}, round ${this.round}.`);
    } else if (winningBlockID === StakeBlockchain.NIL) {
      // If we receive 2/3 NIL votes, release any locks.
      delete this.lockedBlock;
    } else {
      // There is some ambiguity between Tendermint 0.5 and 0.6.  TM 0.5
      // indicates that a validator locks on to a **proposal**.  TM 0.6 instead
      // states that a validator locks on to a **block**.  We follow the latter.
      this.log(`Locking on to block ${winningBlockID}`);
      this.lockedBlock = this.proposedBlocks[winningBlockID];
    
      // Broadcasting successful precommit.
      let vote = Vote.makeVote(this, StakeBlockchain.PRECOMMIT, winningBlockID);
      this.net.broadcast(StakeBlockchain.PRECOMMIT, vote);
    }

    // Setting to decide on whether to commit.
    setTimeout(() => this.commitDecision(), this.round*StakeBlockchain.DELTA);
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

    this.log(`Committing to block ${winningBlockID}`);

    let vote = Vote.makeVote(this, StakeBlockchain.COMMIT, winningBlockID);
    this.net.broadcast(StakeBlockchain.COMMIT, vote);

    setTimeout(() => this.finalizeCommit(), this.round*StakeBlockchain.DELTA);
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
      this.log(`No consensus on ${this.nextBlock.id} (${this.height}-${this.round}) yet.  Waiting...`);
      setTimeout(() => this.finalizeCommit(), StakeBlockchain.DELTA);
    } else {
      this.commits = {};
      setTimeout(() => this.newHeight(), StakeBlockchain.COMMIT_TIME);
    }
  }

  newHeight() {
    // **FIXME** Gather up signatures.

    // Announce new block.
    this.currentBlock = this.nextBlock;
    this.announceProof();

    // Reset details
    //this.commits = {};
    delete this.nextBlock;
    delete this.lockedBlock;
    //this.round = 0;

    // Start working on the next block.
    this.receiveBlock(this.currentBlock);
    this.startNewSearch();
    this.newRound();
    //setTimeout(() => {
    //  this.startNewSearch();
    //  this.newRound();
    //}, 0);
  }

  addTransaction(tx) {
    tx = StakeBlockchain.makeTransaction(tx);
    this.transactions.add(tx);
  }

  postEvidenceTransaction(faultyAddr, oldMessage, newMessage) {
    // Broadcasting the new transaction.
    let tx = StakeBlockchain.makeTransaction({
      from: this.address,
      nonce: this.nonce,
      pubKey: this.keyPair.public,
      outputs: [],
      fee: 0,
      data: {
        type: StakeBlock.TX_TYPE_EVIDENCE,
        byzantinePlayer: faultyAddr,
        msg1: oldMessage,
        msg2: newMessage,
      },
    });

    tx.sign(this.keyPair.private);

    // Adding transaction to pending.
    this.pendingOutgoingTransactions.set(tx.id, tx);

    this.nonce++;

    this.log(`Posting evidence transaction ${tx.id} against ${faultyAddr}`);

    this.net.broadcast(StakeBlockchain.POST_TRANSACTION, tx);

    this.addTransaction(tx, this);

    return tx;

    //throw new Error(`
    //  Possible Byzantine behavior by ${faultyAddr}.
    //  Received conflicting messages:
    //  -> ${JSON.stringify(oldMessage)}
    //  -> ${JSON.stringify(newMessage)}`);
  }

};
