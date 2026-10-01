import * as process from "node:process";

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  botToken: string;
  databaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  ownerUsername: string;
  allowedChatUsername?: string | undefined;
  allowedChatId?: number | undefined;
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

function readRequiredString(name: string, value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is not defined`);
  }

  return value.trim();
}

export function getConfig(): AppConfig {
  const allowedChatUsername = process.env.ALLOWED_CHAT_USERNAME?.trim() || undefined;
  const rawChatId = process.env.ALLOWED_CHAT_ID?.trim();
  const allowedChatId = rawChatId ? Number(rawChatId) : undefined;
  if (
    rawChatId &&
    (!/^-\d+$/.test(rawChatId) ||
      !Number.isSafeInteger(allowedChatId) ||
      allowedChatId === undefined ||
      allowedChatId >= 0)
  ) {
    throw new Error("ALLOWED_CHAT_ID must be a negative safe integer");
  }
  if (allowedChatId === undefined && !allowedChatUsername) {
    throw new Error("ALLOWED_CHAT_ID or ALLOWED_CHAT_USERNAME must be defined");
  }
  return {
    nodeEnv: readEnum("NODE_ENV", "development", environments),
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort(),
    logLevel: readEnum("LOG_LEVEL", "info", logLevels),
    databaseUrl: readRequiredString("DATABASE_URL", process.env.DATABASE_URL),
    botToken: readRequiredString("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN),
    openaiApiKey: readRequiredString("OPENAI_API_KEY", process.env.OPENAI_API_KEY),
    openaiModel: readRequiredString("OPENAI_MODEL", process.env.OPENAI_MODEL ?? "gpt-6.1-sol"),
    allowedChatUsername,
    allowedChatId,
    ownerUsername: readRequiredString("OWNER_USERNAME", process.env.OWNER_USERNAME),
  };
}
