import * as process from 'node:process';

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  botToken: string;
  ownerUserId: string;
  allowedChatId: string;
}>;

const environments = new Set<AppConfig["nodeEnv"]>(["development", "test", "production"]);
const logLevels = new Set<AppConfig["logLevel"]>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

function readEnum<T extends string>(name: string, fallback: T, values: ReadonlySet<T>): T {
  const value = process.env[name] ?? fallback;
  if (!values.has(value as T)) {
    throw new Error(`${name} must be one of: ${[...values].join(", ")}`);
  }
  return value as T;
}

function readPort(): number {
  const value = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return value;
}

function handleString(name: string, value: string | undefined, ): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} is not defined`);
  }

  return value;
}

export function getConfig(): AppConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not defined");
  }

  return {
    nodeEnv: readEnum("NODE_ENV", "development", environments),
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort(),
    logLevel: readEnum("LOG_LEVEL", "info", logLevels),
    botToken: handleString('TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN),
    allowedChatId: handleString('ALLOWED_CHAT_ID', process.env.ALLOWED_CHAT_ID),
    ownerUserId: handleString('OWNER_USER_ID', process.env.OWNER_USER_ID),
  };
}
