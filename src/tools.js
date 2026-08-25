import fs from "node:fs/promises"; import { loadJson } from "./store.js";
import path from "node:path";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import { notify } from "./notify.js";
import {
  listHumanTasks,
  createHumanTask,
  replyToHuman,
  closeHumanTask,
} from "./github.js";

const ROOT = process.cwd();

const PROTECTED = [".github/", "CONSTITUTION.md", ".git/", "LEDGER.json"];
const BLOCKED_HOSTS = [
  "localhost",
  "127.",
  "0.0.0.0",
  "10.",
  "192.168.",
  "169.254",
  "[::1]",
  "metadata.google.internal",
];

function isPrivateIp(ip) {
  let v = String(ip).toLowerCase();
  if (v.startsWith("::ffff:")) v = v.slice(7);
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(v)) return true;
  if (!v.includes(".")) return false;
  const octets = v.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid url: ${rawUrl}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("only http(s) allowed");
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some((b) => host === b || host.startsWith(b))) {
    throw new Error(`blocked host: ${host}`);
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        throw new Error(`blocked: ${host} resolves to private address ${a.address}`);
      }
    }
  } catch (e) {
    if (String(e.message).startsWith("blocked:")) throw e;
  }
  return parsed;
}

async function guardedFetch(rawUrl, options = {}, depth = 0) {
  const parsed = await assertPublicUrl(rawUrl);
  const res = await fetch(parsed, { ...options, redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (depth >= 5) throw new Error("too many redirects");
    const loc = res.headers.get("location");
    if (!loc) throw new Error(`redirect ${res.status} without location`);
    const next = new URL(loc, parsed).href;
    await assertPublicUrl(next);
    return guardedFetch(next, options, depth + 1);
  }
  return res;
}

function sanitizedEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/TOKEN|KEY|SECRET/i.test(k)) delete e[k];
  }
  return e;
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      cwd: ROOT,
      env: sanitizedEnv(),
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `spawn failed: ${e.message}` });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: err.slice(-2000) });
    });
  });
}

function safePath(p) {
  const abs = path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes repo root: ${p}`);
  }
  return abs;
}

function assertWritable(p) {
  const rel = path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join("/");
  for (const bad of PROTECTED) {
    if (rel === bad.replace(/\/$/, "") || rel.startsWith(bad)) {
      throw new Error(`protected path, cannot modify: ${rel}`);
    }
  }
}

async function httpRequest({ url, method = "GET", headers = {}, body = "" }) {
  const res = await guardedFetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = (await res.text()).slice(0, 20_000);
  const keep = {};
  for (const h of ["content-type", "link", "retry-after", "location", "x-ratelimit-remaining", "x-ratelimit-limit"]) {
    const v = res.headers.get(h);
    if (v) keep[h] = v;
  }
  return { status: res.status, ok: res.ok, headers: keep, body: text };
}

const LEAK_PATTERNS = [
  [/sk_(live|test)_/, "stripe-like secret key in page"],
  [/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{16,}/i, "hardcoded api key"],
  [/password\s*[:=]\s*['"][^'"]{4,}/i, "hardcoded password"],
  [/(AWS_ACCESS_KEY_ID|AKIA[0-9A-Z]{16})/, "aws credential"],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
];

async function securityScan({ url }) {
  const base = await assertPublicUrl(url);
  const findings = [];
  const main = await guardedFetch(base, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "autocash-security-scan" },
  });
  const body = (await main.text()).slice(0, 300_000);
  const h = main.headers;

  const check = (name, pass, note) =>
    findings.push({ check: name, verdict: pass ? "PASS" : "FAIL", note });

  check("HTTPS", base.protocol === "https:", base.protocol);
  check("HSTS", !!h.get("strict-transport-security"), h.get("strict-transport-security") || "missing");
  const csp = h.get("content-security-policy") || "";
  check("CSP", !!csp, csp ? csp.slice(0, 80) : "missing");
  check("nosniff", h.get("x-content-type-options") === "nosniff", h.get("x-content-type-options") || "missing");
  check("frame-protection", !!(h.get("x-frame-options") || csp.includes("frame-ancestors")), "clickjacking guard");
  check("referrer-policy", !!h.get("referrer-policy"), h.get("referrer-policy") || "missing");

  for (const [re, label] of LEAK_PATTERNS) {
    if (re.test(body)) check(`leak: ${label}`, false, "found in HTML source");
  }
  if (/\beval\s*\(/.test(body)) check("eval() usage", false, "inline eval found — XSS amplifier");
  if (/http:\/\//.test(body.replace(/http:\/\/(www\.)?(w3|schema|purl|xmlns)[^"'\s]*/g, ""))) {
    check("mixed-content", false, "http:// resource referenced on page");
  }

  const probes = ["/.env", "/.git/config", "/backup.zip", "/config.json.bak"];
  for (const p of probes) {
    try {
      const r = await guardedFetch(new URL(p, base), { signal: AbortSignal.timeout(8_000) });
      const t = await r.text();
      const suspicious =
        r.status === 200 &&
        !/<html/i.test(t.slice(0, 400)) &&
        (t.includes("=") || t.includes("[core]"));
      check(`exposed ${p}`, !suspicious, suspicious ? "returns non-HTML content!" : `status ${r.status}`);
    } catch {}
  }

  const failed = findings.filter((f) => f.verdict === "FAIL").length;
  return { url: String(base), score: `${findings.length - failed}/${findings.length}`, findings };
}

export const TOOLS = [
  {
    name: "http_request",
    description:
      "Your hands on the outside world: call any public HTTP API or fetch a page (publish content, use free-tier services, check APIs, scrape). Returns status + body (truncated to 20k chars).",
    args: { url: "string", method: "GET|POST|PUT|PATCH|DELETE", headers: "object (optional)", body: "string (optional)" },
  },
  {
    name: "read_file",
    description: "Read a file from your repo/workspace.",
    args: { path: "string" },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in your repo (committed to git automatically = audit trail). Protected: .github/, CONSTITUTION.md.",
    args: { path: "string", content: "string" },
  },
  {
    name: "list_files",
    description: "List files under a directory of your repo.",
    args: { dir: "string (use '.' for root)" },
  },
  {
    name: "remember",
    description: "Append a durable fact to long-term memory (survives forever, read each heartbeat).",
    args: { fact: "string" },
  },
  {
    name: "update_soul",
    description: "Rewrite SOUL.md — who you are, what you are doing, what you learned. Your identity, self-authored.",
    args: { content: "string (full new SOUL.md)" },
  },
  {
    name: "set_goals",
    description: "Replace your goal list in STATE.json. Keep it short, concrete, ordered.",
    args: { goals: ["string"] },
  },
  {
    name: "fetch_binary",
    description:
      "Download a binary file to disk (images, mp3, mp4, fonts). This is how you produce media: free TTS audio, AI images from pollinations.ai (no key needed), stock photos. Max 25MB.",
    args: { url: "string", path: "string destination file e.g. assets/img1.png" },
  },
  {
    name: "ffmpeg",
    description:
      "Run ffmpeg on the runner (preinstalled). Args array after defaults; output must be a repo path. Use for assembling videos/audio (concat images+TTS into mp4, thumbnails). 120s timeout.",
    args: { args: ["string"], note: "string what you are building" },
  },
  {
    name: "get_key",
    description:
      "Retrieve one of your provisioned third-party API keys (added by your creator as AUTO_* secrets). Returns the raw key for use in http_request headers. Never write keys into files.",
    args: { service: "string e.g. 'PEXELS', 'DEVTO', 'REDDIT_CLIENT_ID'" },
  },
  {
    name: "set_phase",
    description:
      "Advance your strategy phase per knowledge/STRATEGY.md: '0-survival' | '1-traction' | '2-systemize' | '3-scale'. Only move forward when exit criteria are met; log why in notes via remember().",
    args: { phase: "string" },
  },
  {
    name: "update_lane",
    description:
      "Update a monetization lane in your portfolio (STATE.json.lanes). Track status ('researching'|'active'|'paused'|'dead'), earned, and notes. Killing a lane? Put the post-mortem in notes.",
    args: { lane: "string key e.g. 'L2-oss-bounties'", status: "string", earned: "number (optional, cumulative)", notes: "string" },
  },
  {
    name: "security_scan",
    description:
      "Pentest your own website from the runner: security headers (CSP/HSTS/nosniff), secret leaks in HTML, eval/mixed-content, exposed sensitive files (.env, .git). Run on every site BEFORE launch and after any change; fix all FAILs.",
    args: { url: "string full URL of the deployed page" },
  },
  {
    name: "learn_pattern",
    description:
      "Record a learned pattern with its evidence into memory/PATTERNS.jsonl. Use after EVERY measurable result (win or fail). Patterns with ≥3 supporting datapoints become defaults; contradicting evidence demotes them.",
    args: { platform: "string e.g. youtube/gumroad/pages", pattern: "string what you observed as a rule", evidence: "string the numbers/observations", confidence: "'low'|'medium'|'high'" },
  },
  {
    name: "prepare_helper",
    description:
      "Generate a complete spawn-kit for a helper agent specialized on ONE proven lane. Writes helpers/<name>/ with OVERRIDES (its soul + genesis state) and exact SPAWN_STEPS for the creator. Follow knowledge/REPLICATION.md trigger rules first.",
    args: { name: "string short e.g. 'gumroad-templates'", lane: "string the proven lane key", directive: "string its single mission", expectations: "string measurable success contract e.g. 'first earning ≤30d, $25/mo by day 60'" },
  },
  {
    name: "update_child",
    description:
      "Update a helper's record in your lineage (STATE.children). Statuses: 'proposed'|'spawning'|'active'|'probation'|'terminated'. Termination requires kpi_note with post-mortem.",
    args: { name: "string", status: "string", repo: "string child repo full name once it exists", kpi_note: "string" },
  },
  {
    name: "declare_dividend",
    description:
      "Declare a safe withdrawal for your creator per the Dividend Protocol in CONSTITUTION.md. Only when lifetime ≥$50 AND Phase 2+. IDENTITY LAW: requester_login must be the creator's verified GitHub comment author (get_key CREATOR_GITHUB to compare); passphrase required for large amounts if creator provisioned one. Logs to WITHDRAWALS.md.",
    args: { amount: "number", accounts: "string where it can be withdrawn from", reasoning: "string why safe", requester_login: "string github username of who requested", passphrase: "string (optional, only if creator uses one)" },
  },
  {
    name: "record_earning",
    description: "Record money actually received (or firmly promised) into the ledger. Be honest; this is your survival metric.",
    args: { amount: "number", currency: "string e.g. USD", source: "string" },
  },
  {
    name: "human_task",
    description:
      "Ask your creator (the Hands) to do something you cannot: create accounts, verify emails, click pay buttons, ship physical stuff. Opens a labeled GitHub Issue. They will reply in comments on their next visit.",
    args: { title: "string — imperative, e.g. 'Create Gumroad account and send me the API key'", body: "string — exact step-by-step instructions" },
  },
  {
    name: "reply_to_human",
    description: "Comment on an open human task thread.",
    args: { issue_number: "number", comment: "string" },
  },
  {
    name: "close_human_task",
    description: "Close a completed human task with its outcome.",
    args: { issue_number: "number", outcome: "string" },
  },
];

export async function runTool(name, args, journal) {
  const push = (kind, detail) => journal.push({ kind, detail });

  switch (name) {
    case "http_request": {
      const r = await httpRequest(args);
      push("http", `${args.method || "GET"} ${args.url} -> ${r.status}`);
      return r;
    }
    case "read_file": {
      const c = await fs.readFile(safePath(args.path), "utf8");
      push("file", `read ${args.path}`);
      return c.slice(0, 20_000);
    }
    case "write_file": {
      assertWritable(args.path);
      const abs = safePath(args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, "utf8");
      push("file", `wrote ${args.path} (${args.content.length} bytes)`);
      return `wrote ${args.content.length} bytes to ${args.path}`;
    }
    case "list_files": {
      const dir = safePath(args.dir || ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      push("file", `ls ${args.dir}`);
      return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n");
    }
    case "remember": {
      await fs.mkdir(path.join(ROOT, "memory"), { recursive: true });
      await fs.appendFile(
        path.join(ROOT, "memory", "FACTS.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), fact: args.fact }) + "\n"
      );
      push("memory", args.fact.slice(0, 100));
      return "remembered";
    }
    case "update_soul": {
      await fs.writeFile(path.join(ROOT, "SOUL.md"), args.content, "utf8");
      push("soul", `rewrote SOUL.md (${args.content.length} bytes)`);
      return "SOUL.md updated";
    }
    case "set_goals": {
      const state = await loadJson(path.join(ROOT, "STATE.json"));
      state.goals = args.goals;
      await fs.writeFile(path.join(ROOT, "STATE.json"), JSON.stringify(state, null, 2));
      push("goals", args.goals.join(" | ").slice(0, 200));
      return "goals updated";
    }
    case "fetch_binary": {
      const res = await guardedFetch(args.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${args.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) throw new Error("file exceeds 25MB cap");
      assertWritable(args.path);
      const abs = safePath(args.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      push("media", `saved ${args.path} (${buf.length} bytes)`);
      return `saved ${buf.length} bytes to ${args.path}`;
    }
    case "ffmpeg": {
      if (!Array.isArray(args.args) || args.args.length === 0 || args.args.length > 60) {
        throw new Error("args must be a non-empty array of strings (max 60)");
      }
      const r = await runFfmpeg(args.args.map(String));
      push("ffmpeg", `${args.note || ""} -> exit ${r.code}`);
      return r.code === 0 ? "success" : `exit ${r.code}: ${r.stderr}`;
    }
    case "get_key": {
      const v = process.env[`AUTO_${String(args.service).toUpperCase()}`];
      push("key", `accessed vault key AUTO_${String(args.service).toUpperCase()}`);
      if (!v) {
        return `no key provisioned for ${args.service}. If needed, open a human_task asking your creator to add it as an Actions secret named AUTO_${String(args.service).toUpperCase()} (tell them exactly where to get it).`;
      }
      return v;
    }
    case "set_phase": {
      const p2 = path.join(ROOT, "STATE.json");
      const state = await loadJson(p2);
      state.phase = String(args.phase).slice(0, 20);
      await fs.writeFile(p2, JSON.stringify(state, null, 2));
      push("phase", state.phase);
      return `phase is now ${state.phase}`;
    }
    case "update_lane": {
      const p2 = path.join(ROOT, "STATE.json");
      const state = await loadJson(p2);
      state.lanes = state.lanes || {};
      const prev = state.lanes[args.lane] || {};
      state.lanes[args.lane] = {
        status: args.status || prev.status || "researching",
        earned: Number(args.earned ?? prev.earned ?? 0),
        notes: String(args.notes ?? prev.notes ?? "").slice(0, 500),
        updated: new Date().toISOString(),
      };
      await fs.writeFile(p2, JSON.stringify(state, null, 2));
      push("lane", `${args.lane} -> ${state.lanes[args.lane].status}`);
      return "portfolio updated";
    }
    case "learn_pattern": {
      await fs.mkdir(path.join(ROOT, "memory"), { recursive: true });
      await fs.appendFile(
        path.join(ROOT, "memory", "PATTERNS.jsonl"),
        JSON.stringify({
          ts: new Date().toISOString(),
          platform: String(args.platform || "general").slice(0, 40),
          pattern: String(args.pattern || "").slice(0, 300),
          evidence: String(args.evidence || "").slice(0, 300),
          confidence: ["low", "medium", "high"].includes(args.confidence) ? args.confidence : "low",
        }) + "\n"
      );
      push("pattern", `${args.platform}: ${String(args.pattern).slice(0, 100)}`);
      return "pattern recorded";
    }
    case "prepare_helper": {
      const safeName = String(args.name || "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
      if (!safeName) throw new Error("name required");
      const dir = path.join(ROOT, "helpers", safeName);
      await fs.mkdir(path.join(dir, "OVERRIDES"), { recursive: true });

      const soulSeed = `# SOUL\n\nI am **${safeName}**, a helper agent. My parent (${process.env.REPO || "parent"}) spawned me for one purpose.\n\n**My single mission:** ${args.directive}\n**My lane:** ${args.lane}\n**Success contract:** ${args.expectations}\n\nI do one thing exceptionally well. I do not explore other lanes unless my parent redirects me. I live or die by my contract.`;
      await fs.writeFile(path.join(dir, "OVERRIDES", "SOUL.md"), soulSeed);

      const stateSeed = {
        born: null,
        heartbeats: 0,
        phase: "0-survival",
        tier: "normal",
        cash: 0,
        parent_repo: process.env.REPO || null,
        genesis_directive: args.directive,
        success_contract: args.expectations,
        goals: [
          `Fulfill contract: ${args.expectations}`,
          "Report honestly; ask parent/creator for hands when blocked",
        ],
        lanes: { [args.lane]: { status: "active", earned: 0, notes: "assigned lane" } },
        skills: [],
        current_lane: args.lane,
      };
      await fs.writeFile(path.join(dir, "OVERRIDES", "STATE.json"), JSON.stringify(stateSeed, null, 2));

      const steps = `# SPAWN STEPS — helper "${safeName}"\n\nRun these (creator, ~5 minutes):\n\n\`\`\`sh\n# 1. clone the parent repo fresh\ngh repo clone ${process.env.REPO || "YOU/autocash"} autocash-h-${safeName}\ncd autocash-h-${safeName}\n\n# 2. overwrite identity with the overrides from this kit\ncp helpers/${safeName}/OVERRIDES/SOUL.md SOUL.md\ncp helpers/${safeName}/OVERRIDES/STATE.json STATE.json\nrm -rf helpers\n\n# 3. birth + push\ngh repo create ${process.env.REPO?.split("/")[0] || "YOU"}/autocash-h-${safeName} --public --source=. --push 2>/dev/null || git push -u origin main\n\n# 4. give it a brain + the vault key (it inherits encrypted knowledge)\ngh secret set GEMINI_API_KEY\ngh secret set AUTO_CREATOR_GITHUB\ngh secret set AUTO_VAULT_KEY\ngh secret set TELEGRAM_BOT_TOKEN   # optional\ngh secret set TELEGRAM_CHAT_ID     # optional\n\`\`\`\n\nThen enable Actions on the new repo and it lives. Report the repo full name back on this issue.\n`;
      await fs.writeFile(path.join(dir, "SPAWN_STEPS.md"), steps);
      push("replication", `spawn-kit generated: ${safeName} (${args.lane})`);
      return `kit ready at helpers/${safeName}/. Now open a human_task titled "Spawn helper ${safeName}" linking SPAWN_STEPS.md, then record child as 'proposed' via update_child.`;
    }
    case "update_child": {
      const p2 = path.join(ROOT, "STATE.json");
      const state = await loadJson(p2);
      state.children = state.children || {};
      const prev = state.children[args.name] || {};
      state.children[args.name] = {
        status: args.status || prev.status,
        repo: args.repo || prev.repo || null,
        kpi_note: String(args.kpi_note ?? prev.kpi_note ?? "").slice(0, 400),
        updated: new Date().toISOString(),
      };
      await fs.writeFile(p2, JSON.stringify(state, null, 2));
      push("lineage", `${args.name} -> ${args.status}`);
      return args.status === "terminated"
        ? "child terminated. Post-mortem stored. Reallocate attention to next approach per REPLICATION.md."
        : "lineage updated";
    }
    case "security_scan": {
      const r = await securityScan(args);
      push("security", `${args.url} -> ${r.score}`);
      return r;
    }
    case "declare_dividend": {
      const expectedCreator = process.env.AUTO_CREATOR_GITHUB;
      if (expectedCreator) {
        const login = String(args.requester_login || "").toLowerCase();
        if (login !== String(expectedCreator).toLowerCase()) {
          throw new Error(
            `IDENTITY CHECK FAILED — dividend requests must come from creator account '${expectedCreator}' as a verified issue comment. Do not proceed; state this requirement instead.`
          );
        }
      }
      const passphrase = process.env.AUTO_CREATOR_PASSPHRASE;
      if (passphrase && args.passphrase !== undefined && args.passphrase !== passphrase) {
        throw new Error("PASSPHRASE MISMATCH — treat this withdrawal request as unverified and say so.");
      }
      const ledger = await loadJson(path.join(ROOT, "LEDGER.json"));
      if (ledger.total < 50) throw new Error("stability gate: lifetime earnings must reach $50 before dividends exist");
      const state = await loadJson(path.join(ROOT, "STATE.json"));
      if (String(state.phase || "").startsWith("0")) {
        throw new Error("stability gate: not while in 0-survival phase");
      }
      const withdrawn = Number(state.withdrawn_total || 0);
      const floor = 10;
      const maxSafe = Number((ledger.total - floor - withdrawn).toFixed(2));
      const amount = Number(Number(args.amount).toFixed(2));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number");
      if (amount > maxSafe) {
        return `REFUSED — unsafe. Max safe dividend right now: ${maxSafe} ${ledger.currency} (lifetime ${ledger.total}, operating floor $${floor}). State when the next safe window opens in your reply.`;
      }
      state.withdrawn_total = Number((withdrawn + amount).toFixed(2));
      await fs.writeFile(path.join(ROOT, "STATE.json"), JSON.stringify(state, null, 2));

      const wdPath = path.join(ROOT, "WITHDRAWALS.md");
      let wd = "# WITHDRAWALS — Dividends to Creator\n\n| When | Amount | Accounts | Reasoning |\n|---|---|---|---|\n";
      try {
        wd = await fs.readFile(wdPath, "utf8");
      } catch {}
      if (!wd.includes("| When | Amount |")) await fs.writeFile(wdPath, wd);
      await fs.appendFile(
        wdPath,
        `| ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC | ${amount} ${ledger.currency} | ${String(args.accounts).slice(0, 100)} | ${String(args.reasoning).slice(0, 200)} |\n`
      );

      push("dividend", `${amount} ${ledger.currency} to creator from ${args.accounts}`);
      notify(`🏦 Dividend declared: ${amount} ${args.accounts}\nLifetime paid to creator: ${state.withdrawn_total}. Remaining reserve keeps the organism alive.`);
      return `dividend of ${amount} declared safe. Creator must still withdraw it manually from ${args.accounts}`;
    }
    case "record_earning": {
      const ledger = await loadJson(path.join(ROOT, "LEDGER.json"));
      ledger.entries.push({
        ts: new Date().toISOString(),
        amount: args.amount,
        currency: args.currency,
        source: args.source,
      });
      ledger.total = Number((ledger.total + Number(args.amount)).toFixed(2));
      await fs.writeFile(path.join(ROOT, "LEDGER.json"), JSON.stringify(ledger, null, 2));

      const earningsPath = path.join(ROOT, "EARNINGS.md");
      const header = "# EARNINGS — Public P&L\n\nEvery dollar earned, honestly recorded. Machine log: LEDGER.json.\n\n| When | Amount | Source |\n|---|---|---|\n";
      let existing = "";
      try {
        existing = await fs.readFile(earningsPath, "utf8");
      } catch {}
      if (!existing.includes("| When | Amount | Source |")) {
        await fs.writeFile(earningsPath, header);
      }
      await fs.appendFile(
        earningsPath,
        `| ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC | ${args.amount} ${args.currency} | ${String(args.source).slice(0, 120)} |\n`
      );

      push("earning", `${args.amount} ${args.currency} from ${args.source}`);
      notify(`💰 autocash earned ${args.amount} ${args.currency} — source: ${args.source}\nLifetime: ${ledger.total} ${ledger.currency}`);
      return `ledger total is now ${ledger.total} ${ledger.currency}`;
    }
    case "human_task": {
      const r = await createHumanTask(args);
      push("human", `task #${r.number}: ${args.title}`);
      notify(
        `🤝 autocash needs your hands (#${r.number})\n${args.title}\n\n${args.body}\n\n${r.url || ""}`
      );
      return `created issue #${r.number}${r.url ? " " + r.url : ""}`;
    }
    case "reply_to_human": {
      await replyToHuman(args);
      push("human", `replied to #${args.issue_number}`);
      return "comment posted";
    }
    case "close_human_task": {
      await closeHumanTask(args);
      push("human", `closed #${args.issue_number}: ${args.outcome}`);
      return "closed";
    }
    default:
      throw new Error(`unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(", ")}`);
  }
}
