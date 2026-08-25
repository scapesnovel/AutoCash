import fs from "node:fs/promises";
import { createAlertIssue } from "./github.js";
import { notify } from "./notify.js";

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

export async function markSuccess() {
  try {
    const state = JSON.parse((await fs.readFile("STATE.json", "utf8")).replace(/^\uFEFF/, ""));
    if (state.consecutive_failures) {
      state.consecutive_failures = 0;
      await fs.writeFile("STATE.json", JSON.stringify(state, null, 2));
    }
  } catch {}
}

export async function reportFailure(err) {
  let count = 0;
  let lastAlert = null;
  try {
    const raw = (await fs.readFile("STATE.json", "utf8")).replace(/^\uFEFF/, "");
    const state = JSON.parse(raw);
    count = (state.consecutive_failures || 0) + 1;
    state.consecutive_failures = count;
    lastAlert = state.last_failure_alert || null;
    await fs.writeFile("STATE.json", JSON.stringify(state, null, 2));
  } catch {}

  const alertDue =
    count >= 3 && (!lastAlert || Date.now() - new Date(lastAlert).getTime() > THREE_DAYS);
  if (alertDue) {
    try {
      const msg = String(err?.message || err).slice(0, 1500);
      const body = `Heartbeat failed **${count}** consecutive time(s).\n\n\`\`\`\n${msg}\n\`\`\`\n\nLikely causes: all LLM keys rate-limited/expired, a broken self-modification commit, or GitHub-side issues. Check the latest [Actions run](https://github.com/${process.env.REPO}/actions) — revert the newest heartbeat commit if a code change caused this.`;
      const r = await createAlertIssue({
        title: "🚨 autocash is failing and needs help",
        body,
      });
      try {
        const s2 = JSON.parse(
          (await fs.readFile("STATE.json", "utf8")).replace(/^\uFEFF/, "")
        );
        s2.last_failure_alert = new Date().toISOString();
        await fs.writeFile("STATE.json", JSON.stringify(s2, null, 2));
      } catch {}
      console.error("[autocash] alert filed:", r.number);
    } catch {}
  }
  await notify(
    `🚨 autocash heartbeat FAILED (${count}x): ${String(err?.message || err).slice(0, 300)}`
  ).catch(() => {});
}
