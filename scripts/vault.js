import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOTS = ["knowledge", "memory", "helpers"];
const FILES = [
  "CONSTITUTION.md",
  "SOUL.md",
  "STATE.json",
  "LEDGER.json",
  "EARNINGS.md",
  "STANDUP.md",
  "WITHDRAWALS.md",
];

function loadKey() {
  let k = process.env.AUTO_VAULT_KEY;
  if (!k) {
    const keyFile = path.join(process.cwd(), "vault.key");
    if (fsSync.existsSync(keyFile)) k = fsSync.readFileSync(keyFile, "utf8").trim();
  }
  if (!k || !/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("vault key missing/invalid: set AUTO_VAULT_KEY (64 hex chars) or vault.key file");
  }
  return Buffer.from(k, "hex");
}

function collectPlaintexts(dir, out = []) {
  if (!fsSync.existsSync(dir)) return out;
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectPlaintexts(p, out);
    else if (!e.name.endsWith(".enc")) out.push(p);
  }
  return out;
}

function collectEncrypted(dir, out = []) {
  if (!fsSync.existsSync(dir)) return out;
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectEncrypted(p, out);
    else if (e.name.endsWith(".enc")) out.push(p);
  }
  return out;
}

function encryptFile(file, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = fsSync.readFileSync(file);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  fsSync.writeFileSync(
    file + ".enc",
    JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      d: enc.toString("base64"),
    })
  );
}

function decryptFile(encPath, key) {
  const { iv, tag, d } = JSON.parse(fsSync.readFileSync(encPath, "utf8"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(d, "base64")), decipher.final()]);
}

const mode = process.argv[2];
const key = loadKey();

if (mode === "enc") {
  let n = 0;
  for (const root of ROOTS) {
    for (const f of collectPlaintexts(root)) {
      encryptFile(f, key);
      n++;
    }
  }
  for (const f of FILES) {
    if (fsSync.existsSync(f)) {
      encryptFile(f, key);
      n++;
    }
  }
  console.log(`[vault] encrypted ${n} files`);
} else if (mode === "dec") {
  let n = 0;
  for (const root of ROOTS) {
    for (const e of collectEncrypted(root)) {
      const target = e.slice(0, -4);
      fsSync.mkdirSync(path.dirname(target), { recursive: true });
      fsSync.writeFileSync(target, decryptFile(e, key));
      n++;
    }
  }
  for (const f of FILES) {
    if (fsSync.existsSync(f + ".enc")) {
      fsSync.writeFileSync(f, decryptFile(f + ".enc", key));
      n++;
    }
  }
  console.log(`[vault] decrypted ${n} files`);
} else {
  console.error("usage: node scripts/vault.js enc|dec  (key via AUTO_VAULT_KEY env or ./vault.key)");
  process.exit(1);
}
