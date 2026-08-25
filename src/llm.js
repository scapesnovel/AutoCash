const PROVIDERS = [
  {
    name: "groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    key: () => process.env.GROQ_API_KEY,
  },
  {
    name: "gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: () => process.env.GEMINI_MODEL || "gemini-2.5-flash",
    key: () => process.env.GEMINI_API_KEY,
  },
  {
    name: "github-models",
    endpoint: "https://models.github.ai/inference/chat/completions",
    model: () => process.env.GH_MODEL || "openai/gpt-4o-mini",
    key: () => process.env.GITHUB_TOKEN,
  },
  {
    name: "cerebras",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    model: () => process.env.CEREBRAS_MODEL || "llama-3.3-70b",
    key: () => process.env.CEREBRAS_API_KEY,
  },
  {
    name: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: () => process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free",
    key: () => process.env.OPENROUTER_API_KEY,
  },
  {
    name: "mistral",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    model: () => process.env.MISTRAL_MODEL || "mistral-small-latest",
    key: () => process.env.MISTRAL_API_KEY,
  },
  {
    name: "cohere",
    endpoint: "https://api.cohere.ai/compatibility/v1/chat/completions",
    model: () => process.env.COHERE_MODEL || "command-r7b-12-2024",
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
  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
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
          model: p.model(),
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
      return { content, provider: `${p.name}:${p.model()}` };
    } catch (e) {
      errors.push(`${p.name} [${p.model()}]: ${e.message}`);
    }
  }
  throw new Error(
    errors.length
      ? `All providers failed:\n${errors.join("\n")}`
      : "No LLM API keys configured. Add GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY etc. as repo secrets."
  );
}
