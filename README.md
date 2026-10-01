# Astra Bot

Fastify service for a Telegram moderation bot and a restricted AI assistant.

## Local development

Requirements: Node.js 22+ and Corepack-enabled pnpm.

```bash
cp .env.example .env
corepack pnpm install
corepack pnpm db:generate
# Fill in .env, then start the local database (or use your own PostgreSQL).
docker compose up -d --wait
corepack pnpm db:migrate
corepack pnpm dev
```

Set `TELEGRAM_BOT_TOKEN`, `OWNER_USERNAME`, `OPENAI_API_KEY`, and
`DATABASE_URL` in `.env`. Set `ALLOWED_CHAT_ID` to the negative Telegram group ID (for example,
`-1001234567890`) for a private group, or `ALLOWED_CHAT_USERNAME` for a public supergroup.
If both are set, the ID takes precedence. For the local Compose database, also set `POSTGRES_PASSWORD` and use
`postgresql://astra:<your-url-encoded-password>@localhost:5432/astra` as `DATABASE_URL`.
For an existing PostgreSQL instance, Compose is optional. Migrations create new memory tables;
`db:migrate` applies the checked-in migration and does not reset the database.
`OPENAI_MODEL` defaults to `gpt-6.1-sol` and must name a model available to your OpenAI project.

The HTTP surface exposes `GET /health`, `GET /ready`, and `GET /me` on port `3000`.
Usernames can be entered with or without `@`; comparisons ignore case. Groups without a public username are authorized by ID.
Telegram uses long polling. `/ask <question>` is available to administrators of the configured group
and to `OWNER_USERNAME` in a private chat. Anonymous administrators cannot use `/ask`.
Requests time out after 60 seconds,
accept up to 8000 input characters, and generate up to 2048 output tokens. Only one question per user
in a chat can be pending. Long answers are sent as plain text in multiple replies.
Provider response storage is disabled, and request/response contents are not logged.

## Conversation memory

PostgreSQL stores `Conversation`, `Message`, and `ConversationSummary` through Prisma 7.
The runtime requires migrated tables; it connects and checks cleanup before starting Telegram polling.
Generate the Prisma client after installing dependencies with `pnpm db:generate` (build also generates it).

Ordinary text received in the allowed group and the owner's private chat contributes to context.
Each group topic has separate shared memory; private chats are isolated by Telegram chat ID.
Other chats are ignored. Commands other than `/ask` are excluded. The bot responds only to `/ask`.
Group members' text is context, while assistant access still requires administrator status.
For ordinary group messages to reach the bot, make it a group administrator or disable privacy mode
in BotFather. Memory starts with updates the bot receives; this implementation does not import earlier
Telegram history. Edited messages, attachments, and messages from other bots are not collected.

Each request includes an existing summary, recent messages with author attribution, and a quoted
reply when present. Recent context is limited to 12,000 UTF-8 bytes, summaries to 3,000 bytes, and
individual stored messages to 8,000 bytes. These are conservative size limits, not exact token counts;
long messages are truncated without breaking Unicode. At most 60 recent rows are read per request.
Instructions for Astra are separate from the untrusted conversation context.

Summarization runs in the background once unsummarized history reaches 40 messages or exceeds the
recent-context byte budget. It keeps up to 12 recent messages verbatim, summarizes bounded batches,
and starts at most one job per conversation every 30 seconds. Backlogs and failed jobs are retried
while the process is running. Summary generation uses `OPENAI_MODEL`; it incurs an additional API
request only when compaction is needed. `/ask` uses the currently available summary without waiting.
One polling process is supported; summary versions prevent stale database writes, but running multiple
bot processes is not supported.

`/reset` clears the current chat/topic's messages and summary; group administrators can reset shared
topic memory, and the owner can reset private memory. Raw messages expire after seven days, with
cleanup at startup and hourly. Summaries remain while a conversation is active; conversations idle
for seven days are deleted. Deleted or edited Telegram messages are not automatically reconciled.
A summary can omit details; recent verbatim messages remain the source for exact wording.

Run database integration tests against a dedicated, migrated test database:

```bash
TEST_DATABASE_URL=<test-postgresql-url> corepack pnpm test
```

Without `TEST_DATABASE_URL`, the database integration test is skipped; unit and Telegram tests run.

## Commands

- `pnpm dev` — run with reload.
- `pnpm build && pnpm start` — build and run production output.
- `pnpm db:generate` — generate the Prisma client.
- `pnpm db:migrate` — apply checked-in PostgreSQL migrations.
- `pnpm db:dev` — create a migration during development.
- `pnpm check` — typecheck, lint, formatting, tests, and agent-harness audit.
- `pnpm sync:agents` — rebuild agent indexes and local adapters from `ai/`.

Agent navigation starts in [AGENTS.md](AGENTS.md). Product and safety context lives in
[AGENT_CONTEXT.md](AGENT_CONTEXT.md).
