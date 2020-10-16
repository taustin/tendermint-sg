"use strict";

const StakeBlockchain = require('./stake-blockchain.js');
const Validator = require('./validator.js');
const Vote = require('./vote.js');

/**
 * This class behaves like a normal validator until it receives
 * a proposal.  At that point, it votes for the proposal and also
 * for a Nil block.
 */
module.exports = class ByzantineVoter extends Validator {

  prevote() {
    super.prevote();
    let vote = Vote.makeNilVote(this, StakeBlockchain.PREVOTE);
    this.net.broadcast(StakeBlockchain.PREVOTE, vote);
  }

};
