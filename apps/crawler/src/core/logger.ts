export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function consoleLogger(scope: string): Logger {
  const prefix = scope ? `[${scope}] ` : "";
  return {
    info: (message) => console.log(`${prefix}${message}`),
    warn: (message) => console.warn(`${prefix}${message}`),
    error: (message) => console.error(`${prefix}${message}`),
  };
}
