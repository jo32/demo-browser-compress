import {
  FileTranformingWorker,
  FileTranformingWorkerReceivedPaylaod,
  FileTranformingWorkerStatus,
  FileTranformingWorkeInitPaylaod,
  getLogger
} from "./lib";
import { Lock, Cond } from "./lock";

import pako from "pako";

const logger = getLogger("CompressWorker");

class CustromDeflate extends pako.Deflate {

  __ftm: FileTranformingWorker;

  constructor(ftm: FileTranformingWorker) {
    super({
      chunkSize: ftm.__readBufferSize < ftm.__writeBufferSize ? ftm.__readBufferSize : ftm.__writeBufferSize
    });
    this.__ftm = ftm;
  }

  onData(chunk: Uint8Array) {
    this.__ftm.__writeLock.lock();
    let writeView = new Uint8Array(
      this.__ftm.__writeBuffer as SharedArrayBuffer,
      0,
      chunk.byteLength
    );
    writeView.set(chunk);
    postMessage(["push", chunk.byteLength]);
    this.__ftm.__writeCond.wait();
    this.__ftm.__writeLock.unlock();
  }

  onEnd(status: number) {
    super.onEnd(status);
    postMessage(["finish"]);
  }
}

class CompressWorker extends FileTranformingWorker {

  __deflator: CustromDeflate | undefined;

  constructor() {
    super();
  }

  onMessage(data: FileTranformingWorkerReceivedPaylaod) {
    if (!data.length || data.length < 2) {
      throw new Error("incorrect payload format");
    }
    let [evt, payload] = data;
    switch (evt) {
      case "init":
        payload = payload as FileTranformingWorkeInitPaylaod;
        this.__readBuffer = payload.readBuffer;
        this.__writeBuffer = payload.writeBuffer;
        this.__readBufferSize = payload.opts.readBufferSize;
        this.__writeBufferSize = payload.opts.writeBufferSize;

        this.__lockSab = payload.lockSab;
        this.__fileLength = payload.fileLength;

        // read lock is write lock in main thread
        this.__readLock = new Lock(this.__lockSab, 2 * 8) as any;
        this.__readCond = new Cond(this.__readLock, 3 * 8) as any;
        this.__writeLock = new Lock(this.__lockSab, 0 * 8) as any;
        this.__writeCond = new Cond(this.__writeLock, 1 * 8) as any;

        this.__deflator = new CustromDeflate(this);
        postMessage(["inited"]);
        this.__status = FileTranformingWorkerStatus.INITED;
        break;
      case "push":
        logger(`[msg ${evt}] start`);
        if (this.__status == FileTranformingWorkerStatus.INITED) {
          this.__status = FileTranformingWorkerStatus.WORKING;
        } else if (this.__status == FileTranformingWorkerStatus.WORKING) {
          // do nothing
        } else {
          throw new Error(
            `preccedding status is ${this.__status}, expected: ${FileTranformingWorkerStatus.WORKING} or ${FileTranformingWorkerStatus.INITED}`
          );
        }

        this.__readLock.lock();
        while (this.__readOffset < this.__fileLength) {
          logger(`[msg ${evt}] while loop, offset ${this.__readOffset}, fileLength ${this.__fileLength}`);
          let readLength = this.__readBufferSize;
          if (this.__readOffset + this.__readBufferSize > this.__fileLength) {
            readLength = this.__fileLength % this.__readBufferSize;
          }
          let readView = new Uint8Array(
            this.__readBuffer as SharedArrayBuffer,
            0,
            readLength
          );
          let isFinished = this.__readOffset + readLength >= this.__fileLength ? true : false;
          this.__deflator!.push(readView, isFinished);
          this.__readCond.notifyOne();
          if (this.__readOffset + readLength < this.__fileLength) {
            this.__readCond.wait();
          }
          this.__readOffset += readLength;
        }
        this.__readLock.unlock();
        logger(`[msg ${evt}] end`);
        break;
      default:
        throw new Error(`unsupported message ${evt} found`);
    }
  }
}

// eslint-disable-next-line no-restricted-globals
const ctx: Worker = self as any;

const cw = new CompressWorker();

// Respond to message from parent thread
ctx.addEventListener("message", (event) => {
  cw.onMessage(event.data);
});
