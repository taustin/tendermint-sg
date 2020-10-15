"use strict";

const { FakeNet } = require('spartan-gold');

module.exports = class UnreliableNet extends FakeNet {

  /**
   * Specifies a chance of a message failing to be sent and
   * the maximum delay of a message (in milliseconds) if it
   * is sent.
   * 
   * This version is designed to simulate more realistic network
   * conditions for testing.
   * 
   * The messageDelay parameter is the maximum -- a message may
   * be delayed any amount of time between 0 ms and the delay specified.
   * 
   * @param {number} chanceMessageFails - Should be in the range of 0 to 1.
   * @param {number} messageDelay - Time that a message may be delayed.
   */
  constructor(chanceMessageFails, messageDelay) {
    super();
    this.chanceMessageFails = chanceMessageFails;
    this.messageDelayMax = messageDelay;
  }

  /**
   * Sends message msg and payload o directly to Client name.
   * 
   * The message may be lost or delayed, with the probability
   * defined for this instance.
   *
   * @param {String} address - the public key address of the client or miner to which to send the message
   * @param {String} msg - the name of the event being broadcasted (e.g. "PROOF_FOUND")
   * @param {Object} o - payload of the message
   */
  sendMessage(address, msg, o) {
    if (typeof o !== 'object') throw new Error(`Expecting an object, but got a ${typeof o}`);

    // Serializing/deserializing the object to prevent cheating in single threaded mode.
    let o2 = JSON.parse(JSON.stringify(o));

    const client = this.clients.get(address);

    let delay = Math.floor(Math.random() * this.messageDelayMax);

    if (Math.random() > this.chanceMessageFails) {
      setTimeout(() => client.emit(msg, o2), delay);
    }
  }

};