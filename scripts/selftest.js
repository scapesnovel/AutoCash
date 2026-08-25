import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const sandbox = path.join(projectRoot, ".selftest");

fsSync.rmSync(sandbox, { recursive: true, force: true });
fsSync.mkdirSync(path.join(sandbox, "memory"), { recursive: true });
for (const f of ["STATE.json", "LEDGER.json", "EARNINGS.md", "SOUL.md", "STANDUP.md", "CONSTITUTION.md"]) {
  fsSync.copyFileSync(path.join(projectRoot, f), path.join(sandbox, f));
}

process.chdir(sandbox);

let exitCode = 0;
try {
  const { run } = await import(pathToFileURL(path.join(here, "selftest.core.js")));
  exitCode = (await run(projectRoot)) ? 1 : 0;
} catch (e) {
  console.error("SELFTEST CRASHED:", e);
  exitCode = 1;
} finally {
  process.chdir(projectRoot);
  fsSync.rmSync(sandbox, { recursive: true, force: true });
}
process.exit(exitCode);
