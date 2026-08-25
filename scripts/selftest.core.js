import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function run(projectRoot) {
  const results = [];
  const test = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (e) {
      results.push(`FAIL ${name} :: ${e.message.split("\n")[0]}`);
    }
  };

  const imp = async (p) => import(pathToFileURL(path.join(projectRoot, "src", p)).href);
  const { runTool } = await imp("tools.js");
  const { chat } = await imp("llm.js");

  await test("llm mock returns scripted actions", async () => {
    process.env.MOCK = "1";
    const r1 = await chat([{ role: "user", content: "x" }]);
    const r2 = await chat([{ role: "user", content: "x" }]);
    assert.ok(r1.content.includes("remember"));
    assert.ok(r2.content.includes('"none"'));
    delete process.env.MOCK;
  });

  await test("protected paths rejected", async () => {
    await assert.rejects(() =>
      runTool("write_file", { path: ".github/workflows/evil.yml", content: "x" }, [])
    );
    await assert.rejects(() =>
      runTool("write_file", { path: "CONSTITUTION.md", content: "x" }, [])
    );
  });

  await test("path escape rejected", async () => {
    await assert.rejects(() =>
      runTool("write_file", { path: "../escape.txt", content: "x" }, [])
    );
    await assert.rejects(() => runTool("read_file", { path: "../../etc/passwd" }, []));
  });

  await test("record_earning updates ledger + public P&L", async () => {
    await runTool("record_earning", { amount: 3.5, currency: "USD", source: "test-sale" }, []);
    const ledger = JSON.parse(await fs.readFile("LEDGER.json", "utf8"));
    assert.strictEqual(ledger.total, 3.5);
    assert.strictEqual(ledger.entries.length, 1);
    const pnl = await fs.readFile("EARNINGS.md", "utf8");
    assert.ok(pnl.includes("3.5 USD") && pnl.includes("test-sale"));
  });

  await test("bom-tolerant json reads", async () => {
    await fs.writeFile("STATE.json", "\uFEFF" + (await fs.readFile("STATE.json", "utf8")));
    const r = await runTool("set_phase", { phase: "1-traction" }, []);
    assert.ok(r.includes("1-traction"));
  });

  await test("dividend refused in survival phase", async () => {
    await assert.rejects(
      () => runTool("declare_dividend", { amount: 1, accounts: "x", reasoning: "y" }, []),
      /stability gate/
    );
  });

  await test("learn_pattern appends", async () => {
    await runTool(
      "learn_pattern",
      { platform: "youtube", pattern: "hooks under 5s retain", evidence: "n=1", confidence: "low" },
      []
    );
    const p = await fs.readFile("memory/PATTERNS.jsonl", "utf8");
    assert.ok(p.includes("youtube"));
  });

  await test("prepare_helper generates sanitized spawn kit", async () => {
    const r = await runTool(
      "prepare_helper",
      { name: "Test Helper!", lane: "L1", directive: "run templates shop", expectations: "$1 in 30d" },
      []
    );
    assert.ok(r.includes("kit ready"));
    const soul = await fs.readFile("helpers/test-helper/OVERRIDES/SOUL.md", "utf8");
    assert.ok(soul.includes("templates shop"));
    const steps = await fs.readFile("helpers/test-helper/SPAWN_STEPS.md", "utf8");
    assert.ok(steps.includes("gh repo create"));
  });

  await test("security_scan blocks internal hosts", async () => {
    await assert.rejects(() => runTool("security_scan", { url: "http://localhost:8080/" }, []));
  });

  await test("update_lane persists portfolio", async () => {
    await runTool("update_lane", { lane: "L1-digital", status: "active", earned: 3.5, notes: "t" }, []);
    const s = JSON.parse(await fs.readFile("STATE.json", "utf8"));
    assert.strictEqual(s.lanes["L1-digital"].status, "active");
  });

  await test("full mock heartbeat end-to-end", async () => {
    const r = spawnSync(process.execPath, [path.join(projectRoot, "src", "index.js")], {
      cwd: process.cwd(),
      env: { ...process.env, MOCK: "1", RUN_ID: "selftest" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr?.slice(0, 300)}`);
    const journal = (await fs.readFile("memory/JOURNAL.jsonl", "utf8")).trim();
    assert.ok(journal.includes("run_end"));
  });

  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  return fails;
}
