const GH_API = "https://api.github.com";

function ghHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "autocash",
    "content-type": "application/json",
  };
}

function enabled() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.REPO);
}

async function gh(path, token, options = {}) {
  const res = await fetch(`${GH_API}/repos/${process.env.REPO}${path}`, {
    ...options,
    headers: ghHeaders(token),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function listHumanTasks() {
  if (!enabled()) return Promise.resolve([]);
  const token = process.env.GITHUB_TOKEN;
  return gh("/issues?labels=hands&state=open&per_page=20", token).then((issues) =>
    Promise.all(
      issues
        .filter((i) => !i.pull_request)
        .map(async (issue) => ({
          number: issue.number,
          title: issue.title,
          body: (issue.body || "").slice(0, 2000),
          comments: await gh(
            `/issues/${issue.number}/comments?per_page=50`,
            token
          ).then((cs) =>
            cs.map((c) => ({ user: c.user.login, body: c.body.slice(0, 2000) }))
          ),
        }))
    )
  );
}

export async function createHumanTask({ title, body }) {
  if (!enabled()) return { number: -1 };
  const issue = await gh("/issues", process.env.GITHUB_TOKEN, {
    method: "POST",
    body: JSON.stringify({ title, body, labels: ["hands"] }),
  });
  return { number: issue.number, url: issue.html_url };
}

export async function createAlertIssue({ title, body }) {
  if (!enabled()) return { number: -1 };
  const issue = await gh("/issues", process.env.GITHUB_TOKEN, {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      labels: ["hands", "alert"],
    }),
  });
  return { number: issue.number, url: issue.html_url };
}

export async function replyToHuman({ issue_number, comment }) {
  if (!enabled()) return;
  await gh(`/issues/${issue_number}/comments`, process.env.GITHUB_TOKEN, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  });
}

export async function closeHumanTask({ issue_number, outcome }) {
  if (!enabled()) return;
  await gh(`/issues/${issue_number}/comments`, process.env.GITHUB_TOKEN, {
    method: "POST",
    body: JSON.stringify({ body: `Closing task. Outcome: ${outcome}` }),
  });
  await gh(`/issues/${issue_number}`, process.env.GITHUB_TOKEN, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}
