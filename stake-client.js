"use strict";

const { Client } = require('spartan-gold');

const StakeMixin = require('./stake-mixin.js');

module.exports = class StakeClient extends Client {

  constructor(...args) {
    super(...args);

    // Mixing in common methods/properties for clients and validators.
    Object.assign(this, StakeMixin);
  }



  /**
   * In addition to the usual issues with determining what gold is available,
   * with the coin-locking model we must also consider how much gold is
   * currently locked.
   */
  get availableGold() {
    return super.availableGold - this.amountGoldStaked();
  }


};
