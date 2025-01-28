// wasi:io/poll@0.2.0 interface



// Pollable represents a single I/O event which may be ready, or not.
export class Pollable {
  /**
   * @type {{ ready: (boolean | function(): boolean), asyncFunc: (undefined | function(): Promise) }}
   */
  #state;

  /**
   * Sets the pollable to ready whether the promise is resolved or
   * rejected.
   *
   * @param {Promise|{ ready: function(): boolean, asyncFunc: function(): Promise }|undefined|null} state
   */
  constructor(state) {
    if (!state) {
      // always ready
      this.#state = { ready: true };
    } else if (state.then) {
      // is single promise that terminates into ready state
      const setReady = () => {
        this.#state.ready = true;
      };
      this.#state = { ready: false, asyncFunc: () => state.then(setReady, setReady) };
    } else {
      // can be multiple promises that could change readiness
      this.#state = state;
    }
  }

  /**
   * Return the readiness of a pollable. This function never blocks.
   *
   * Returns `true` when the pollable is ready, and `false` otherwise.
   *
   * @returns {boolean}
   */
  ready() {
    // `this.#state.ready` could be `true`, `false`, or a `function(): boolean`
    return !this.#state.ready ?
      false : this.#state.ready === true ?
        true : this.#state.ready();
  }

  /**
   * Returns immediately if the pollable is ready, and otherwise blocks
   * until ready.
   * 
   * This function is equivalent to calling `poll.poll` on a list
   * containing only this pollable.
   */
  async block() {
    if (!this.ready()) {
      await this.#state.asyncFunc();
    }
  }
}

/**
 * Poll for completion on a set of pollables.
 * 
 * This function takes a list of pollables, which identify I/O
 * sources of interest, and waits until one or more of the events
 * is ready for I/O.
 * 
 * The result list<u32> contains one or more indices of handles
 * in the argument list that is ready for I/O.
 *
 * @param {Array<Pollable>} inList
 * @returns {Promise<Uint32Array>}
 */
export const poll = async (inList) => {
  if (inList.length === 1) {
    // handle this common case faster
    await inList[0].block();
    return new Uint32Array(1); // zero initialized of length 1
  }

  // wait until at least one is ready
  await Promise.race(inList.map((pollable) => pollable.block()));

  // allocate a Uint32Array list as if all are ready
  const ready = new Uint32Array(inList.length);
  let pos = 0;
  for (let i = 0; i < inList.length; i++) {
    if (inList[i].ready()) {
      ready[pos] = i;
      pos++;
    }
  }

  return ready.subarray(0, pos);
};
