/* eslint-disable */
/*
   Copyright 2017 Mozilla Corporation.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

if (!Atomics) {
  throw "Incompatible embedding: Atomics object not available";
}
if (Atomics.wake && !Atomics.notify) {
  Atomics.notify = Atomics.wake;
}

// Simple, standalone lock and condition variable abstractions.  See README.md
// for a general introduction, browser-test.html and shell-test.js for examples,
// and comments below for API specs.
//
// Lock and Cond have no mutable state - all mutable state is in the shared
// memory.

("use strict");

// Private

let _checkParameters = function (sab, loc, truth, who) {
  if (
    !(
      sab instanceof SharedArrayBuffer &&
      (loc | 0) == loc &&
      loc >= 0 &&
      loc % truth.ALIGN == 0 &&
      loc + truth.NUMBYTES <= sab.byteLength
    )
  ) {
    throw new Error("Bad arguments to " + who + ": " + sab + " " + loc);
  }
};

//////////////////////////////////////////////////////////////////////
//
// Locks.
//
// Locks are JS objects that use some shared memory for private data.
//
// The number of shared bytes needed is given by Lock.NUMBYTES, and their
// alignment in the SAB is given by Lock.ALIGN.
//
// The shared memory for a lock should be initialized once by calling
// Lock.initialize() on the memory, before constructing the first Lock object in
// any agent.
//
// Note that you should not call the "lock" operation on the main
// thread in a browser, because the main thread is not allowed to wait.
// However, "tryLock" is OK.
//
// Implementation note:
// Lock code taken from http://www.akkadia.org/drepper/futex.pdf.
// Lock states:
//   0: unlocked
//   1: locked with no waiters
//   2: locked with possible waiters

// Initialize shared memory for a lock, before constructing the worker-local
// Lock objects on that memory.
//
// `sab` must be a SharedArrayBuffer.
// `loc` must be a valid index in `sab`, divisible by Lock.ALIGN, and there must
// be space at 'loc' for at least Lock.NUMBYTES.
//
// Returns `loc`.

Lock.initialize = function (sab, loc) {
  _checkParameters(sab, loc, Lock, "Lock initializer");
  Atomics.store(new Int32Array(sab, loc, 1), 0, 0);
  return loc;
};

// Number of shared byte locations needed by the lock.  A multiple of 4.

Lock.NUMBYTES = 4;

// Byte alignment needed by the lock.  A multiple of 4.

Lock.ALIGN = 4;

// Create a Lock object.
//
// `sab` must be a SharedArrayBuffer.
// `loc` must be a valid index in `sab`, divisible by Lock.ALIGN, and there must
// be space at 'loc' for at least Lock.NUMBYTES.

export function Lock(sab, loc) {
  _checkParameters(sab, loc, Lock, "Lock constructor");
  this._iab = new Int32Array(sab); // View the whole thing so we can share with Cond
  this._ibase = loc >>> 2;
}

// Acquire the lock, or block until we can.  Locking is not recursive: you must
// not hold the lock when calling this.

Lock.prototype.lock = function () {
  const iab = this._iab;
  const stateIdx = this._ibase;
  let c;
  if ((c = Atomics.compareExchange(iab, stateIdx, 0, 1)) != 0) {
    do {
      if (c == 2 || Atomics.compareExchange(iab, stateIdx, 1, 2) != 0)
        Atomics.wait(iab, stateIdx, 2);
    } while ((c = Atomics.compareExchange(iab, stateIdx, 0, 2)) != 0);
  }
};

// Attempt to acquire the lock, return true if it was acquired, false if not.
// Locking is not recursive: you must not hold the lock when calling this.

Lock.prototype.tryLock = function () {
  const iab = this._iab;
  const stateIdx = this._ibase;
  return Atomics.compareExchange(iab, stateIdx, 0, 1) == 0;
};

// Unlock a lock that is held.  Anyone can unlock a lock that is held; nobody
// can unlock a lock that is not held.

Lock.prototype.unlock = function () {
  const iab = this._iab;
  const stateIdx = this._ibase;
  let v0 = Atomics.sub(iab, stateIdx, 1);
  // Wake up a waiter if there are any
  if (v0 != 1) {
    Atomics.store(iab, stateIdx, 0);
    Atomics.notify(iab, stateIdx, 1);
  }
};

// Debugging support.

Lock.prototype.toString = function () {
  return "{/*Lock*/ loc:" + this._ibase * 4 + "}";
};

// Return a representation that can be postMessage'd.  The result is an Object
// with a property "isLockObject" whose value is true, and other fields.

Lock.prototype.serialize = function () {
  return { isLockObject: true, sab: this._iab.buffer, loc: this._ibase * 4 };
};

// Create a new Lock object from a serialized representation.
//
// `repr` must have been produced by Lock.p.serialize().

Lock.deserialize = function (repr) {
  if (typeof repr != "object" || repr == null || !repr.isLockObject) {
    return null;
  }
  return new Lock(repr.sab, repr.loc);
};

//////////////////////////////////////////////////////////////////////
//
// Condition variables.
//
// Condition variables are JS objects that use some shared memory for private
// data.
//
// The number of shared bytes needed is given by Cond.NUMBYTES, and their
// alignment in the SAB is given by Cond.ALIGN.
//
// The shared memory for a Cond variable should be initialized once by calling
// Cond.initialize() on the memory, before constructing the first Cond object in
// any agent.
//
// A Cond variable is always constructed on a Lock, which is available as the
// `lock` property of the Cond instance.  Note especially that the Cond and the
// Lock must be constructed on the same SharedArrayBuffer.
//
// Note that you should not call the Cond.p.wait() operation from the main
// thread in a browser, because the main thread is not allowed to wait.
//
//
// Implementation note:
// The Cond code is based on http://locklessinc.com/articles/mutex_cv_futex,
// though modified because some optimizations in that code don't quite apply.

// Initialize shared memory for a condition variable, before constructing the
// worker-local Cond objects on that memory.
//
// `sab` must be a SharedArrayBuffer, the same SAB that is used by the Lock that
// will be associated with the Cond.
// `loc` must be a valid index in `sab`, divisible by Cond.ALIGN, and there must
// be space at 'loc' for at least Cond.NUMBYTES.
//
// Returns 'loc'.

Cond.initialize = function (sab, loc) {
  _checkParameters(sab, loc, Cond, "Cond initializer");
  Atomics.store(new Int32Array(sab, loc, 1), 0, 0);
  return loc;
};

// Create a condition variable that can wait on a lock.
//
// `lock` must be a Lock instance.
// `loc` must be a valid index in the shared memory of `lock`, divisible by
// Cond.ALIGN, and there must be space at `loc` for at least Cond.NUMBYTES.

export function Cond(lock, loc) {
  _checkParameters(
    lock instanceof Lock ? lock._iab.buffer : lock,
    loc,
    Cond,
    "Cond constructor"
  );
  this._iab = lock._iab;
  this._ibase = loc >>> 2;
  this.lock = lock;
}

// Number of shared byte locations needed by the condition variable.  A multiple
// of 4.

Cond.NUMBYTES = 4;

// Byte alignment needed by the lock.  A multiple of 4.

Cond.ALIGN = 4;

// Atomically unlock the cond's lock and wait for a notification on the cond.
// If there were waiters on lock then they are notified as the lock is unlocked.
//
// The caller must hold the lock when calling wait().  When wait() returns the
// lock will once again be held.

Cond.prototype.wait = function () {
  const iab = this._iab;
  const seqIndex = this._ibase;
  const seq = Atomics.load(iab, seqIndex);
  const lock = this.lock;
  lock.unlock();
  Atomics.wait(iab, seqIndex, seq);
  lock.lock();
};

// Notifies one waiter on cond.  The Cond's lock must be held by the caller of
// notifyOne().

Cond.prototype.notifyOne = function () {
  const iab = this._iab;
  const seqIndex = this._ibase;
  Atomics.add(iab, seqIndex, 1);
  Atomics.notify(iab, seqIndex, 1);
};

// Notify all waiters on cond.  The Cond's lock must be held by the caller of
// notifyAll().

Cond.prototype.notifyAll = function () {
  const iab = this._iab;
  const seqIndex = this._ibase;
  Atomics.add(iab, seqIndex, 1);
  Atomics.notify(iab, seqIndex);
};

// Backward compatible aliases.

Cond.prototype.wakeOne = Cond.prototype.notifyOne;
Cond.prototype.wakeAll = Cond.prototype.notifyAll;

// Debugging support.

Cond.prototype.toString = function () {
  return "{/*Cond*/ loc:" + this._ibase * 4 + " lock:" + this.lock + "}";
};

// Return a representation that can be postMessage'd.  The result is an Object
// with a property "isCondObject" whose value is true, and other fields.

Cond.prototype.serialize = function () {
  return {
    isCondObject: true,
    lock: this.lock.serialize(),
    loc: this._ibase * 4,
  };
};

// Create a new Cond object from a serialized representation.
//
// `repr` must have been produced by Cond.p.serialize().

Cond.deserialize = function (repr) {
  if (typeof repr != "object" || repr == null || !repr.isCondObject) {
    return null;
  }
  let lock = Lock.deserialize(repr.lock);
  if (!lock) {
    return null;
  }
  return new Cond(lock, repr.loc);
};

// Addition to lock.js that allows waiting on the browser's main thread using
// async/await or Promise patterns.
//
// REQUIRES
//    lock.js (must be loaded first)

// await this on the main thread.  When the await completes, the lock will be held.

Lock.prototype.asyncLock = async function () {
  const iab = this._iab;
  const stateIdx = this._ibase;
  let c;
  if ((c = Atomics.compareExchange(iab, stateIdx, 0, 1)) != 0) {
    do {
      if (c == 2 || Atomics.compareExchange(iab, stateIdx, 1, 2) != 0)
        await Atomics.waitNonblocking(iab, stateIdx, 2);
    } while ((c = Atomics.compareExchange(iab, stateIdx, 0, 2)) != 0);
  }
}

// await this on the main thread.  When the await completes, the condition will
// have received a signal and will have re-acquired the lock.

Cond.prototype.asyncWait = async function () {
  const iab = this._iab;
  const seqIndex = this._ibase;
  const seq = Atomics.load(iab, seqIndex);
  const lock = this.lock;
  lock.unlock();
  await Atomics.waitNonblocking(iab, seqIndex, seq);
  await lock.asyncLock();
}

  /* Polyfill for Atomics.waitNonblocking() for web browsers, copied from
   * https://github.com/tc39/proposal-atomics-wait-async, relicensed by author for
   * this library.
   */
  ; (function () {
    let helperCode = `
    onmessage = function (ev) {
    	try {
    	    switch (ev.data[0]) {
    	    case 'wait': {
    		let [_, ia, index, value, timeout] = ev.data;
    		let result = Atomics.wait(ia, index, value, timeout)
    		postMessage(['ok', result]);
    		break;
    	    }
    	    default:
    		throw new Error("Bogus message sent to wait helper: " + e);
    	    }
    	} catch (e) {
    	    console.log("Exception in wait helper");
    	    postMessage(['error', 'Exception']);
    	}
    }
    `;

    let helpers = [];

    function allocHelper() {
      if (helpers.length > 0)
        return helpers.pop();
      let h = new Worker("data:application/javascript," + encodeURIComponent(helperCode));
      return h;
    }

    function freeHelper(h) {
      helpers.push(h);
    }

    // Don't load it if it's already there

    if (typeof Atomics.waitNonblocking == "function")
      return;

    // Atomics.waitNonblocking always returns a promise.  Throws standard errors
    // for parameter validation.  The promise is resolved with a string as from
    // Atomics.wait, or, in the case something went completely wrong, it is
    // rejected with an error string.

    Atomics.waitNonblocking = function (ia, index_, value_, timeout_) {
      if (typeof ia != "object" || !(ia instanceof Int32Array) || !(ia.buffer instanceof SharedArrayBuffer))
        throw new TypeError("Expected shared memory");

      // These conversions only approximate the desired semantics but are
      // close enough for the polyfill.

      let index = index_ | 0;
      let value = value_ | 0;
      let timeout = timeout_ === undefined ? Infinity : +timeout_;

      // Range checking for the index.

      ia[index];

      // Optimization, avoid the helper thread in this common case.

      if (Atomics.load(ia, index) != value)
        return Promise.resolve("not-equal");

      // General case, we must wait.

      return new Promise(function (resolve, reject) {
        let h = allocHelper();
        h.onmessage = function (ev) {
          // Free the helper early so that it can be reused if the resolution
          // needs a helper.
          freeHelper(h);
          switch (ev.data[0]) {
            case 'ok':
              resolve(ev.data[1]);
              break;
            case 'error':
              // Note, rejection is not in the spec, it is an artifact of the polyfill.
              // The helper already printed an error to the console.
              reject(ev.data[1]);
              break;
          }
        }

        // It's possible to do better here if the ia is already known to the
        // helper.  In that case we can communicate the other data through
        // shared memory and wake the agent.  And it is possible to make ia
        // known to the helper by waking it with a special value so that it
        // checks its messages, and then posting the ia to the helper.  Some
        // caching / decay scheme is useful no doubt, to improve performance
        // and avoid leaks.
        //
        // In the event we wake the helper directly, we can micro-wait here
        // for a quick result.  We'll need to restructure some code to make
        // that work out properly, and some synchronization is necessary for
        // the helper to know that we've picked up the result and no
        // postMessage is necessary.

        h.postMessage(['wait', ia, index, value, timeout]);
      })
    }
  })();