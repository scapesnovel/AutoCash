import fs from "node:fs/promises";

export async function loadJson(path) {
  let text = await fs.readFile(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

export async function saveJson(path, data) {
  await fs.writeFile(path, JSON.stringify(data, null, 2));
}
