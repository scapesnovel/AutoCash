const PROVIDERS = [
  {
    name: "groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    // llama-3.1-8b-instant + llama-3.3-70b-versatile went Enterprise-only on 2026-08-16 (404 for free tier)
    models: () =>
      process.env.GROQ_MODEL
        ? [process.env.GROQ_MODEL]
        : ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.6-27b"],
    key: () => process.env.GROQ_API_KEY,
  },
  {
    name: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // gemini-2.0-flash was retired by Google (404) — do not re-add it
    models: () =>
      process.env.GEMINI_MODEL
        ? [process.env.GEMINI_MODEL]
        : ["gemini-3.6-flash", "gemini-3.1-flash-lite"],
    key: () => process.env.GEMINI_API_KEY,
  },
  // github-models provider removed: GitHub Models was fully retired on 2026-07-30 (permanent HTTP 410)
  {
    name: "cerebras",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    models: () =>
      process.env.CEREBRAS_MODEL
        ? [process.env.CEREBRAS_MODEL]
        : ["llama-3.3-70b", "gpt-oss-120b", "llama3.1-8b"],
    key: () => process.env.CEREBRAS_API_KEY,
  },
  {
    name: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    models: () =>
      process.env.OPENROUTER_MODEL
        ? [process.env.OPENROUTER_MODEL]
        : [
            "z-ai/glm-5.2:free",
            "deepseek/deepseek-chat-v3-0324:free",
            "minimax/minimax-m2.7:free",
            "nvidia/nemotron-3-super-120b-a12b:free",
            "google/gemma-4-31b-it:free",
          ],
    key: () => process.env.OPENROUTER_API_KEY,
  },
  {
    name: "mistral",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    models: () =>
      process.env.MISTRAL_MODEL
        ? [process.env.MISTRAL_MODEL]
        : ["mistral-small-latest", "open-mistral-nemo"],
    key: () => process.env.MISTRAL_API_KEY,
  },
  {
    name: "cohere",
    endpoint: "https://api.cohere.ai/compatibility/v1/chat/completions",
    models: () =>
      process.env.COHERE_MODEL
        ? [process.env.COHERE_MODEL]
        : ["command-r7b-12-2024", "command-r-08-2024"],
    key: () => process.env.COHERE_API_KEY,
  },
];

const MOCK_SCRIPT = [
  JSON.stringify({
    thought: "Mock boot: verifying I can write memory.",
    tool: "remember",
    args: { fact: "Mock run completed successfully; loop wiring works." },
  }),
  JSON.stringify({
    thought: "Mock boot complete.",
    tool: "none",
    final: "All systems nominal. Awaiting real brain keys.",
  }),
];

let mockStep = 0;

export async function chat(messages) {
  if (process.env.MOCK) {
    const content = MOCK_SCRIPT[Math.min(mockStep++, MOCK_SCRIPT.length - 1)];
    return { content, provider: "mock" };
  }

  const errors = [];
  // pass 0 = normal sweep; pass 1 = one retry sweep after a cooldown,
  // since 429/503/413 are usually transient per-minute limits.
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      const transient = errors.some((e) => /HTTP (429|503|413|500|502)/.test(e));
      if (!transient) break;
      console.log("[autocash] all providers failed with transient errors — cooling down 45s, retrying once");
      await new Promise((r) => setTimeout(r, 45_000));
    }
  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    for (const model of p.models()) {
      try {
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        };
        if (p.name === "openrouter") {
          headers["http-referer"] = "https://github.com";
          headers["x-title"] = "autocash";
        }
        const res = await fetch(p.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 2048,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("empty completion");
        return { content, provider: `${p.name}:${model}` };
      } catch (e) {
        errors.push(`${p.name} [${model}]: ${e.message}`);
      }
    }
  }
  }
  throw new Error(
    errors.length
      ? `All providers failed:\n${errors.join("\n")}`
      : "No LLM API keys configured. Add GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY etc. as repo secrets."
  );
}
