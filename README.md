# Astra Bot

Fastify service for a Telegram moderation bot and a restricted AI assistant.

## Local development

Requirements: Node.js 22+ and Corepack-enabled pnpm.

```bash
cp .env.example .env
corepack pnpm install
corepack pnpm dev
```

The initial HTTP surface exposes `GET /health` and `GET /ready` on port `3000`.

## Commands

- `pnpm dev` — run with reload.
- `pnpm build && pnpm start` — build and run production output.
- `pnpm check` — typecheck, lint, formatting, tests, and agent-harness audit.
- `pnpm sync:agents` — rebuild agent indexes and local adapters from `ai/`.

Agent navigation starts in [AGENTS.md](AGENTS.md). Product and safety context lives in
[AGENT_CONTEXT.md](AGENT_CONTEXT.md).
