import fs from "node:fs";
import path from "node:path";

let loaded = false;

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name} 环境变量`);
  return value;
}

export function loadEnvFile(filePath = path.join(process.cwd(), ".env")): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1));
    if (!key || process.env[key] != null) continue;
    process.env[key] = value;
  }
}
