import fs from "node:fs/promises"; import { loadJson } from "./store.js";
import path from "node:path";
import { chat } from "./llm.js";
import { runTool, TOOLS } from "./tools.js";
import { buildMessages, observationMessage } from "./prompt.js";
import { listHumanTasks } from "./github.js";
import { markSuccess, reportFailure } from "./watchdog.js";

const MAX_TURNS = Number(process.env.HEARTBEAT_TURNS) || 12;
const log = (...a) => console.log("[autocash]", ...a);

function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  return null;
}

async function appendJournal(entry) {
  await fs.mkdir("memory", { recursive: true });
  await fs.appendFile(
    path.join("memory", "JOURNAL.jsonl"),
    JSON.stringify(entry) + "\n"
  );
}

// Keep the transcript small enough for free-tier token limits (e.g. Groq 8K TPM).
// Preserves the system prompt + the most recent exchanges; older observations get truncated.
function compactMessages(messages, budget = 22_000) {
  const size = (m) => (m.content || "").length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return messages;
  const KEEP_TAIL = 6;
  for (let i = 1; i < messages.length - KEEP_TAIL && total > budget; i++) {
    const m = messages[i];
    if (size(m) > 500) {
      total -= size(m) - 500;
      m.content = m.content.slice(0, 400) + "\n…[older context trimmed to save tokens]";
    }
  }
  return messages;
}

async function ensureBorn() {
  const p = path.join("STATE.json");
  const state = await loadJson(p);
  if (!state.born) {
    state.born = new Date().toISOString();
    log("first boot — birth recorded", state.born);
  }
  state.heartbeats = (state.heartbeats || 0) + 1;
  await fs.writeFile(p, JSON.stringify(state, null, 2));
}

async function main() {
  const runId = process.env.RUN_ID || String(Date.now());
  log(`heartbeat ${runId} starting`);

  await ensureBorn();
  const humanTasks = await listHumanTasks().catch((e) => {
    log("issue fetch skipped:", e.message);
    return [];
  });
  log(`open human tasks: ${humanTasks.length}`);

  let messages = await buildMessages({ humanTasks });
  const events = [];
  let provider = "?";
  let finalStatus = "";

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    let content, prov;
    try {
      ({ content, provider: prov } = await chat(messages));
    } catch (e) {
      // If the brain dies mid-run (rate limits, outages), keep the work done so far
      // instead of crashing the whole heartbeat. Only fail hard if turn 1 never worked.
      if (turn === 1) throw e;
      log(`turn ${turn}: all providers failed mid-run — ending gracefully (${e.message.split("\n")[0]})`);
      finalStatus = finalStatus || `run cut short at turn ${turn}: LLM providers unavailable`;
      events.push({ kind: "thought", detail: `providers exhausted at turn ${turn}; run ended early` });
      break;
    }
    provider = prov;
    const action = extractJson(content);

    if (!action || typeof action !== "object") {
      log(`turn ${turn}: non-JSON reply, recording as free thought`);
      events.push({ kind: "thought", detail: content.slice(0, 400) });
      finalStatus = content.slice(0, 200);
      break;
    }

    const toolName = action.tool || "none";
    log(`turn ${turn} [${prov}] -> ${toolName}`);
    events.push({
      kind: "thought",
      detail: `${toolName}: ${String(action.thought || "").slice(0, 300)}`,
    });

    if (toolName === "none" || !TOOLS.some((t) => t.name === toolName)) {
      finalStatus = action.final || action.thought || "";
      break;
    }

    let observation;
    try {
      const result = await runTool(toolName, action.args || {}, events);
      observation = typeof result === "string" ? result : JSON.stringify(result).slice(0, 6_000);
    } catch (e) {
      observation = `TOOL ERROR: ${e.message}`;
      log("tool error:", e.message);
    }

    messages.push({ role: "assistant", content: JSON.stringify(action) });
    messages.push(observationMessage(observation.slice(0, 6_000)));
    messages = compactMessages(messages);
  }

  const summary = {
    ts: new Date().toISOString(),
    run: runId,
    provider,
    turns: events.length,
    status: (finalStatus || "(no final)").slice(0, 300),
  };

  await appendJournal({ ts: summary.ts, kind: "run_end", detail: `provider=${provider} turns=${summary.turns} :: ${summary.status}` });
  for (const e of events.slice(0, 20)) {
    await appendJournal({ ts: summary.ts, kind: e.kind, detail: e.detail });
  }

  const state = await loadJson("STATE.json");
  const today = new Date().toISOString().slice(0, 10);
  if ((Number(process.env.HEARTBEAT_TURNS) || 12) > 20 && state.standup_date !== today) {
    state.standup_date = today;
    await fs.writeFile("STATE.json", JSON.stringify(state, null, 2));
    const ledger = await loadJson("LEDGER.json");
    const did = events.filter((e) => e.kind !== "thought").map((e) => `- (${e.kind}) ${e.detail}`).join("\n") || "- (no tool actions recorded)";
    const block = `\n## ${today}\n**Phase:** ${state.phase || "?"} · **Lifetime:** ${ledger.total} ${ledger.currency} · **Turns used:** ${summary.turns}\n\n${summary.status}\n\n### What I did\n${did}\n`;
    let standup = "# Daily Standup\n\nThe agent files a report here after every nightly deep-work run.\n";
    try {
      standup = await fs.readFile("STANDUP.md", "utf8");
    } catch {}
    const parts = standup.split(/\n## \d{4}-\d{2}-\d{2}/);
    await fs.writeFile("STANDUP.md", parts[0] + block + (parts.length > 1 ? "\n## " + parts.slice(1).join("\n## ") : ""));
    log("standup filed");
  }

  log("heartbeat done:", summary.status);
  await markSuccess();
}

main()
  .catch(async (e) => {
    console.error("[autocash] FATAL", e);
    await reportFailure(e).catch(() => {});
    process.exitCode = 1;
  })
  .then(() => {});

