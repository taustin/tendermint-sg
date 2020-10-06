"use strict";

const { utils } = require('spartan-gold');

/**
 * According to Tendermint 0.6, a proposal consists of:
 * 1) height
 * 2) round
 * 3) block
 * 4) proof-of-lock
 * 5) signature
 * 
 * We add some additional fields for our convenience.
 */
module.exports = class Proposal{

  constructor({from, pubKey, block, blockID, height, round, sig}) {
    this.from = from;
    this.block = block;
    this.height = height;
    this.round = round;
    this.pubKey = pubKey;
    this.sig = sig;

    // The block ID is taken from the block if it is not specified.
    // This design avoids having to reconstitute the block just to
    // extract the ID.
    this.blockID = blockID || this.block.id;
  }

  /**
   * The id of a proposal is a hash of all fields, excluding the signature.
   */
  get id() {
    let o = {
      from: this.from,
      block: this.block,
      height: this.height,
      round: this.round,
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

  /**
   * Verifies that the proposal is correctly signed, is from the correct proposer,
   * and is for the right height and round.
   * 
   * @param {Validator} validator - Used for logging and track proposer/height/round information.
   * 
   * @returns {boolean} - Validity of the proposal.
   */
  isValid(validator) {
    if (this.from !== validator.currentProposer) {
      validator.log(`Expecting proposal from ${validator.currentProposer}, but received one from ${this.address}.`);
      return false;
    } else if (validator.round !== this.round) {
      validator.log(`Out of round: proposal ${this.id} is for round ${this.round}, but should be for ${validator.round}`);
      return false;
    } else if (validator.height !== this.height) {
      validator.log(`Out of height: proposal ${this.id} is for height ${this.height}, but should be for ${validator.height}`);
      return false;
    } else if (!this.hasValidSignature()) {
      validator.log(`Invalid signature for proposal ${this.id}.`);
      return false;
    }
    return true;

  }

};
