import { Lock, Cond } from "./lock";

export function getLogger(prefix: string) {
  return function log(...args: any[]) {
    console.log(prefix, ...args);
  };
}

export function readFileAsArrayBuffer(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let reader = new FileReader();
    reader.onload = (ev) => {
      resolve(ev.target!.result as ArrayBuffer);
    };
    reader.onerror = (ev) => {
      console.error(ev);
      reader.abort();
      reject(new Error("something wrong!"));
    };
    reader.readAsArrayBuffer(file);
  });
}

// Default read and write block size
const DEFAULT_BUFFER_SIZE = 512 * 1024;

export type TaskConf = {
  writeBufferSize: number;
  readBufferSize: number;
};

export const defaultTaskOpts = {
  writeBufferSize: DEFAULT_BUFFER_SIZE,
  readBufferSize: DEFAULT_BUFFER_SIZE,
};

export const WorkerProxyStatus = {
  INIT: 0,
  INITED: 1,
  WORKING: 2,
  FINISHED: 3,
  ERROR: -1,
};

export type WorkerProxyReceivedPaylaod =
  | ["push", number | undefined]
  | ["inited", undefined]
  | ["finish", undefined]
  | ["error", Error];

const workerProxyLogger = getLogger("WorkerProxy");
export class WorkerProxy {
  __ab: ArrayBuffer;
  __worker: Worker;
  __writeBuffer: SharedArrayBuffer;
  __readBuffer: SharedArrayBuffer;
  __lockSab: SharedArrayBuffer;
  __readLock: any;
  __readCond: any;
  __writeLock: any;
  __writeCond: any;
  __opts: TaskConf;
  __targetArrayBuffers: ArrayBuffer[] = [];
  __currentSize: number = 0;
  __status = WorkerProxyStatus.INIT;
  __offset = 0;
  __onProgressCallback: ((progress: number) => void) | undefined = undefined; 

  __doneResolve:
    | ((value?: ArrayBuffer[] | PromiseLike<ArrayBuffer[]> | undefined) => void)
    | undefined = undefined;
  __doneReject: ((reason?: any) => void) | undefined = undefined;

  constructor(worker: Worker, opts: TaskConf, inputBuffer: ArrayBuffer) {
    if (!inputBuffer || !worker || !opts) {
      throw new Error("some parameter given is empty");
    }
    this.__worker = worker;
    this.__opts = opts
      ? Object.assign({}, defaultTaskOpts, opts)
      : defaultTaskOpts;

    // two locks for read and write, two conds for read and write
    this.__lockSab = new SharedArrayBuffer(4 * 8);
    Lock.initialize(this.__lockSab, 0 * 8);
    Cond.initialize(this.__lockSab, 1 * 8);
    Lock.initialize(this.__lockSab, 2 * 8);
    Cond.initialize(this.__lockSab, 3 * 8);
    this.__readLock = new Lock(this.__lockSab, 0 * 8) as any;
    this.__readCond = new Cond(this.__readLock, 1 * 8) as any;
    this.__writeLock = new Lock(this.__lockSab, 2 * 8) as any;
    this.__writeCond = new Cond(this.__writeLock, 3 * 8) as any;

    this.__writeBuffer = new SharedArrayBuffer(this.__opts.writeBufferSize);
    this.__readBuffer = new SharedArrayBuffer(this.__opts.readBufferSize);
    this.__ab = inputBuffer;

    this.__worker.onmessage = (ev) => {
      this.__onMessage(ev.data);
    };
  }

  /**
   * notice:
   *   write buffer in main thread is read buffer in worker
   */
  initWorker() {
    workerProxyLogger("initWorker invoked");
    this.__worker.postMessage([
      "init",
      {
        readBuffer: this.__writeBuffer,
        writeBuffer: this.__readBuffer,
        opts: {
          readBufferSize: this.__opts.writeBufferSize,
          writeBufferSize: this.__opts.readBufferSize,
        },
        fileLength: this.__ab.byteLength,
        lockSab: this.__lockSab
      },
    ]);
  }

  done() {
    return new Promise<ArrayBuffer[]>((resovle, reject) => {
      this.__doneResolve = resovle;
      this.__doneReject = reject;
    });
  }

  onInited() {
    workerProxyLogger("onInited invoked");
    this.__status = WorkerProxyStatus.INITED;
    this.push();
  }

  onProgress(callback: (progress: number) => void) {
    this.__onProgressCallback = callback;
  }

  __onMessage([event, payload]: WorkerProxyReceivedPaylaod) {
    workerProxyLogger("onMessage received event", event);
    switch (event) {
      case "inited":
        this.onInited();
        break;
      case "push":
        this.onReceived(payload as number | undefined);
        break;
      case "finish":
        this.onFinished();
        break;
      case "error":
        this.onError(payload as Error);
        break;
      default:
        throw new Error(`unsupported message ${event} found`);
    }
  }

  /**
   * push the buffer from main thread to writeBuffer

   * @param buffer 
   */
  async push() {

    workerProxyLogger(`[msg push] start`);

    // state checking
    if (this.__status == WorkerProxyStatus.INITED) {
      this.__status = WorkerProxyStatus.WORKING;
    } else if (this.__status == WorkerProxyStatus.WORKING) {
      // do nothing
    } else {
      throw new Error(
        `preccedding status is ${this.__status}, expected: ${WorkerProxyStatus.WORKING} or ${WorkerProxyStatus.INITED}`
      );
    }

    await this.__writeLock.asyncLock();

    while (this.__offset < this.__ab.byteLength) {

      workerProxyLogger(`[msg push] while loop, offset ${this.__offset}, fileLength: ${this.__ab.byteLength}`);
      
      if (this.__offset == 0) {
        this.__worker.postMessage(["push", undefined]);
      }

      let writeSize = this.__opts.writeBufferSize;
      if (this.__offset + this.__opts.writeBufferSize > this.__ab.byteLength) {
        writeSize = this.__ab.byteLength % this.__opts.writeBufferSize;
      }
      let buffer = new Uint8Array(this.__ab, this.__offset, writeSize);
      let view = new Uint8Array(buffer);
      if (view.byteLength > this.__writeBuffer.byteLength) {
        throw new Error(
          `input buffer size is ${view.byteLength}, which exceeded write buffer size: ${this.__writeBuffer.byteLength}`
        );
      }
      let targetView = new Uint8Array(this.__writeBuffer, 0, buffer.byteLength);
      targetView.set(view);
      this.__offset += writeSize;
      await this.__writeCond.notifyOne();
      await this.__writeCond.asyncWait();
    }

    this.__writeLock.unlock();
    workerProxyLogger(`[msg push] end`);
  }

  async onReceived(size: number = this.__opts.readBufferSize) {
    workerProxyLogger("onReceived, size", size);
    await this.__readLock.asyncLock();
    if (this.__status != WorkerProxyStatus.WORKING) {
      return;
    }
    if (size > this.__opts.readBufferSize) {
      throw new Error(
        `expected receive size is over readBufferSize ${this.__opts.readBufferSize}`
      );
    }
    let view = new Uint8Array(this.__readBuffer, 0, size);
    let newBuffer = new ArrayBuffer(size);
    let targetView = new Uint8Array(newBuffer);
    targetView.set(view);
    this.__targetArrayBuffers.push(newBuffer);

    if (this.__onProgressCallback) {
      this.__onProgressCallback(this.__offset / this.__ab.byteLength * 100);
    }

    this.__readCond.notifyOne();
    this.__readLock.unlock();
  }

  onFinished() {
    workerProxyLogger("onFinished");
    this.__status = WorkerProxyStatus.FINISHED;
    if (this.__doneResolve) {
      this.__doneResolve(this.__targetArrayBuffers);
    }
    if (this.__onProgressCallback) {
      this.__onProgressCallback(100);
    }
  }

  onError(err: Error) {
    workerProxyLogger("onError", err);
    this.__status = WorkerProxyStatus.ERROR;
    throw err;
  }
}

export type FileTranformingWorkeInitPaylaod = {
  readBuffer: SharedArrayBuffer;
  writeBuffer: SharedArrayBuffer;
  opts: {
    readBufferSize: number;
    writeBufferSize: number;
  };
  fileLength: number;
  lockSab: SharedArrayBuffer;
};

export type FileTranformingWorkerReceivedPaylaod =
  | ["push", number]
  | ["init", FileTranformingWorkeInitPaylaod];

export const FileTranformingWorkerStatus = {
  INIT: 0,
  INITED: 1,
  WORKING: 2,
  FINISHED: 3,
  ERROR: -1,
};

const ftwLogger = getLogger("FileTranformingWorker");

/**
 * base class of file transforming worker, it implements copy function
 */
export class FileTranformingWorker {
  __writeBuffer: SharedArrayBuffer | undefined;
  __readBuffer: SharedArrayBuffer | undefined;
  __writeBufferSize = 0;
  __readBufferSize = 0;
  __status = FileTranformingWorkerStatus.INIT;
  __lockSab: SharedArrayBuffer | undefined;
  __readLock: any;
  __readCond: any;
  __writeLock: any;
  __writeCond: any;
  __fileLength: number = 0;
  __readOffset: number = 0;

  constructor() {}

  onMessage(data: FileTranformingWorkerReceivedPaylaod) {
    if (!data.length || data.length < 2) {
      throw new Error("incorrect payload format");
    }
    let [evt, payload] = data;
    switch (evt) {
      case "init":
        ftwLogger(`[msg ${evt}]`, payload);
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

        console.log(this.__readLock, this.__readCond, this.__writeLock, this.__writeCond);

        postMessage(["inited"]);
        this.__status = FileTranformingWorkerStatus.INITED;
        break;
      case "push":
        ftwLogger(`[msg ${evt}] start`);
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
          ftwLogger(`[msg ${evt}] while loop, offset ${this.__readOffset}, fileLength ${this.__fileLength}`);
          let readLength = this.__readBufferSize;
          if (this.__readOffset + this.__readBufferSize > this.__fileLength) {
            readLength = this.__fileLength % this.__readBufferSize;
          }

          let readView = new Uint8Array(
            this.__readBuffer as SharedArrayBuffer,
            0,
            readLength
          );          
          this.__writeLock.lock();
          let writeView = new Uint8Array(
            this.__writeBuffer as SharedArrayBuffer,
            0,
            readLength
          );
          writeView.set(readView);
          postMessage(["push", readLength]);
          this.__writeCond.wait();
          this.__writeLock.unlock();
          if (readLength < this.__readBufferSize) {
            postMessage(["finish"]);
          }

          this.__readCond.notifyOne();
          if (this.__readOffset + readLength < this.__fileLength) {
            this.__readCond.wait();
          }
          
          this.__readOffset += readLength;
        }
        this.__readLock.unlock();

        ftwLogger(`[msg ${evt}] end`);
        break;
      default:
        throw new Error(`unsupported message ${evt} found`);
    }
  }
}
