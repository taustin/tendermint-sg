"use strict";

const { utils } = require("spartan-gold");
const StakeBlockchain = require("./stake-blockchain");

/**
 * According to Tendermint v. 0.6, a vote consists of:
 * 1) height
 * 2) round
 * 3) type (prevote, precommit, or commit)
 * 4) block hash
 * 5) signature
 * 
 * We add some additional fields for convenience, including the block itself.
 */
module.exports = class Vote {

  static makeNilVote(voter, type) {
     return Vote.makeVote(voter, type, StakeBlockchain.NIL);
  }

  static makeVote(voter, type, blockID) {
    // Copying over several properties from the voter.
    let vote = new Vote(voter);

    // Adding additional details to vote.
    vote.from = voter.address;
    vote.blockID = blockID;
    vote.type = type;
    vote.pubKey = voter.keyPair.public;

    // Sign and return vote.
    vote.sign(voter.keyPair.private);
    return vote;
  }

  constructor({ from, height, round, type, blockID, pubKey, sig }) {
    this.from = from;
    this.height = height;
    this.round = round;
    this.type = type;

    //if (block !== undefined) {
    //  this.block = block;
    //  this.blockID = block.id;
    //}

    this.blockID = blockID;

    this.pubKey = pubKey;
    this.sig = sig;
  }

  get id() {
    let o = {
      from: this.from,
      height: this.height,
      round: this.round,
      type: this.type,
      blockID: this.blockID,
      pubKey: this.pubKey,
    };

    return utils.hash(JSON.stringify(o));
  }

  /**
   * Sign and store the signature with the specified private key.
   * 
   * @param privKey - private key to sign the proposal.
   */
  sign(privKey) {
    this.sig = utils.sign(privKey, this.id);
  }

  /**
   * Verifies that the signature is valid, and that the from address
   * and the public key in the proposal match.
   */
  hasValidSignature() {
    if (this.sig === undefined) {
      return false;
    } else if (!utils.addressMatchesKey(this.from, this.pubKey)) {
      return false;
    } else {
      return utils.verifySignature(this.pubKey, this.id, this.sig);
    }
  }

  isValid(validator) {
    //if (validator.round !== this.round) {
    //  //validator.log(`Out of round: vote ${this.id} is for round ${this.round}, but should be for ${validator.round}`);
    //  return false;
    //} else if (validator.height !== this.height) {
    //  //validator.log(`Out of height: vote ${this.id} is for height ${this.height}, but should be for ${validator.height}`);
    //  return false;
    //} else
    if (validator.height > this.height) {
      // Stale vote -- previous height.
      validator.log(`Ignoring stale ${this.type} vote ${this.id}: height ${this.height} vs. ${validator.height}`);
      return false;
    }

    // Note that commits are valid for all subsequent rounds.
    if (validator.round > this.round && this.type !== StakeBlockchain.COMMIT) {
      // Stale vote -- previous round.
      validator.log(`Ignoring stale ${this.type} vote ${this.id}: round ${this.round} vs. ${validator.round}`);
      return false;
    }

    if (!this.hasValidSignature()) {
      validator.log(`Invalid signature for vote ${this.id}.`);
      return false;
    }

    return true;
  }

  fresherThan(otherVote) {
    if (this.height > otherVote.height) {
      return true;
    } else if (this.height < otherVote.height) {
      return false;
    }

    // Same height if we made it here
    return this.round > otherVote.round;
  }

};
