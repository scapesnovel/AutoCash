const enc = { "content-type": "application/json" };

function clip(text, n) {
  return String(text).slice(0, n);
}

export async function notify(text) {
  const jobs = [];

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: enc,
        body: JSON.stringify({ chat_id: tgChat, text: clip(text, 3500) }),
        signal: AbortSignal.timeout(8000),
      })
    );
  }

  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (discord) {
    jobs.push(
      fetch(discord, {
        method: "POST",
        headers: enc,
        body: JSON.stringify({ content: clip(text, 1900) }),
        signal: AbortSignal.timeout(8000),
      })
    );
  }

  const ntfy = process.env.NTFY_TOPIC_URL;
  if (ntfy) {
    jobs.push(
      fetch(ntfy, {
        method: "POST",
        body: clip(text, 4000),
        signal: AbortSignal.timeout(8000),
      })
    );
  }

  await Promise.allSettled(jobs);
}
