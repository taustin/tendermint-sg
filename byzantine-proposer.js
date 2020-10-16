"use strict";

const StakeBlockchain = require('./stake-blockchain.js');

const Validator = require('./validator.js');

const SPEND_AMT = 100;

/**
 * This class behaves like a normal validator until it has
 * a turn to propose a block.  At that point, it will propose
 * two conflicting blocks.
 */
module.exports = class ByzantineProposer extends Validator {

  /**
   * When selected as the proposer, the byzantine proposer calls
   * the parent method to propose a block normally, and then
   * proposes an additional block.
   * 
   * To change the block, the proposer pays itself 100 gold.
   * (With a little tweaking, we could turn this setup into
   * a double-spend attempt.)
   */
  proposeBlock() {
    super.proposeBlock();
    
    // Validator pays itself.
    let tx = StakeBlockchain.makeTransaction({
      from: this.address,
      nonce: this.nonce,
      pubKey: this.keyPair.public,
      outputs: [{address: this.address, amount: SPEND_AMT}],
    });

    tx.sign(this.keyPair.private);

    this.currentBlock.addTransaction(tx, this);
    this.shareProposal(this.currentBlock);
  }
};
