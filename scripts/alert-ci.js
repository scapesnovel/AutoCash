import { reportFailure } from "../src/watchdog.js";

const err = new Error(
  `CI self-test failed. The most recent commit likely broke the agent's own code. ` +
    `Revert it: github.com/${process.env.REPO}/commits/main`
);
console.error("[autocash] CI gate failed — paging creator");
await reportFailure(err).catch(() => {});
process.exitCode = 1;
