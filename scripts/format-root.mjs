#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const mode = process.argv[2];

if (!["--write", "--check"].includes(mode) || process.argv.length !== 3) {
  console.error("Usage: node scripts/format-root.mjs --write|--check");
  process.exit(2);
}

const targets = [
  "*.md",
  "*.json",
  "*.js",
  "ai/*.md",
  "ai/dev/**/*.md",
  "ai/roles/**/*.md",
  "ai/skills/**/*.md",
  "**/AGENT_CONTEXT.md",
  "src/**/*.ts",
  "test/**/*.ts",
  "scripts/**/*.{js,mjs,cjs}",
];

// Reuse the pnpm entrypoint that launched this script, including Corepack's
// pinned version when no bare pnpm binary is available on PATH.
const pnpmEntrypoint = process.env.npm_config_user_agent?.startsWith("pnpm/")
  ? process.env.npm_execpath
  : undefined;
const command = pnpmEntrypoint ? process.execPath : "corepack";
const commandArgs = pnpmEntrypoint ? [pnpmEntrypoint] : ["pnpm"];
const result = spawnSync(command, [...commandArgs, "exec", "prettier", mode, ...targets], {
  cwd: root,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
}

const rulesResult = spawnSync(
  command,
  [...commandArgs, "exec", "prettier", mode, "--parser", "markdown", "ai/rules/**/*.mdc"],
  {
    cwd: root,
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);

if (rulesResult.error) {
  console.error(rulesResult.error.message);
}

process.exit(result.status === 0 && rulesResult.status === 0 ? 0 : 1);
