import {
    FileTranformingWorker,
} from "./lib";

// eslint-disable-next-line no-restricted-globals
const ctx: Worker = self as any;

const cw = new FileTranformingWorker();

// Respond to message from parent thread
ctx.addEventListener("message", (event) => {
    cw.onMessage(event.data);
});
