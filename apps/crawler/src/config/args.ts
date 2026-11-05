export type ParsedArgs = {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
};

/**
 * 统一参数解析：
 *   --key value
 *   --key=value
 *   --flag
 *
 * 重复的 key 保留最后一个；需要多值的参数用逗号分隔，由调用方 split。
 * 未知参数由各入口自己检查，避免拼错参数被静默忽略。
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      positionals.push(raw);
      continue;
    }

    const eqIndex = raw.indexOf("=");
    if (eqIndex > 2) {
      values.set(raw.slice(2, eqIndex), raw.slice(eqIndex + 1));
      continue;
    }

    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      values.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }

  return { values, flags, positionals };
}

export function numberArg(args: ParsedArgs, key: string, fallback: number): number {
  const raw = args.values.get(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} 必须是数字：${raw}`);
  return value;
}

export function requireArg(args: ParsedArgs, key: string): string {
  const value = args.values.get(key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
