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
`DATABASE_URL` in `.env`. Set `ALLOWED_CHAT_ID` to one or more negative Telegram group IDs separated by commas (for example,
`-1001234567890,-1009876543210`) for a private group, or `ALLOWED_CHAT_USERNAME` for a public supergroup.
If both are set, the ID list takes precedence. A single ID remains supported.
`/ask`, replies, and mentions in groups write `Telegram assistant request received` with `chatId`
before access checks, including groups not yet allowed. Question text is not logged.
Adding the bot to a group or changing its membership writes `Telegram bot chat membership changed`
to the server log with `chatId`, even for groups outside the allowlist.
`/chatid` in a group replies with its numeric ID and writes `chatId` to the server log,
including groups not yet in the allowlist. Add the returned ID to `ALLOWED_CHAT_ID` and restart.
In groups, assistant tools are scoped to the current chat and topic. When several groups are configured,
owner-private tool calls require an explicit allowed `chat_id`; specify the group in your request. For the local Compose database, also set `POSTGRES_PASSWORD` and use
`postgresql://astra:<your-url-encoded-password>@localhost:5432/astra` as `DATABASE_URL`.
For an existing PostgreSQL instance, Compose is optional. Migrations create new memory tables;
`db:migrate` applies the checked-in migration and does not reset the database.
`OPENAI_MODEL` defaults to `gpt-6-luna` and must name a model available to your OpenAI project.

The HTTP surface exposes `GET /health`, `GET /ready`, and `GET /me` on port `3000`.
Usernames can be entered with or without `@`; comparisons ignore case. Groups without a public username are authorized by ID.
Telegram uses long polling. Current members of the configured group can ask via `/ask <question>`,
a text reply to the bot's own message, or a Telegram @mention of the bot. A mention by Telegram user
ID is also supported. The bot stays silent on unaddressed messages and ignores unrelated commands.
Assistant requests receive the current background moderation setting independently of chat history.
Search tools return a filtered sample of up to three messages received by the bot in the current topic;
they cannot establish that other messages are absent or import Telegram history from before observation.
These entry points share conversation memory, duplicate-update protection, and request limits.
Private assistant access remains limited to the configured owner; bots and anonymous senders cannot
use the assistant. Membership is checked before analysis and before each answer chunk.
Assistant answers longer than 1000 UTF-16 units or at least 12 lines (including blank lines)
are sent as expandable Telegram quotes. Answers exceeding the message chunk size are split,
with each chunk quoted when the full answer meets either threshold.
Conversation requests produce text only and cannot perform bans or message deletions.
`/reset` is restricted separately to group administrators and the private-chat owner.
Requests time out after 60 seconds,
accept up to 8000 input characters, and generate up to 2048 output tokens. Up to eight requests run in the background, with one active request per conversation and
one pending question per user in a chat. Access is checked before each answer chunk. Shutdown waits
for active requests before closing memory and the database. Long answers are sent as plain text in multiple replies.
Provider response storage is disabled, and request/response contents are not logged.

## Conversation memory

PostgreSQL stores `Conversation`, `Message`, and `ConversationSummary` through Prisma 7.
The runtime requires migrated tables; it connects and checks cleanup before starting Telegram polling.
Generate the Prisma client after installing dependencies with `pnpm db:generate` (build also generates it).

Ordinary text received in the allowed group and the owner's private chat contributes to context.
Each group topic has separate shared memory; private chats are isolated by Telegram chat ID.
Other chats are ignored. Commands other than `/ask` are excluded. The bot also handles `/ping` and `/reset`.
Group members' text contributes shared context, and current members can address the assistant.
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
while the process is running. Globally, at most two summary jobs run with up to 64 conversations queued.
When the queue is full, additional scheduling is dropped until a later refresh; stored messages remain
available. Shutdown discards queued jobs and waits for active summaries. Summary generation uses `OPENAI_MODEL`; it incurs an additional API
request only when compaction is needed. `/ask` uses the currently available summary without waiting.
One polling process is supported; summary versions prevent stale database writes, but running multiple
bot processes is not supported.

`/reset` clears the current chat/topic's messages and summary; group administrators can reset shared
topic memory, and the owner can reset private memory. Reset is rejected while any assistant request is
active in the conversation. Raw messages expire after seven days, with
cleanup at startup and hourly. Summaries remain while a conversation is active; conversations idle
for seven days are deleted. Deleted or edited Telegram messages are not automatically reconciled.
A summary can omit details; recent verbatim messages remain the source for exact wording.

Run database integration tests against a dedicated, migrated test database:

```bash
TEST_DATABASE_URL=<test-postgresql-url> corepack pnpm test
```

Without `TEST_DATABASE_URL`, the database integration test is skipped; unit and Telegram tests run.

## Moderation with owner confirmation

Moderation is disabled by default. Set `MODERATION_ENABLED=true` and `OWNER_USERNAME` to your Telegram username, apply migrations with `pnpm db:migrate`, and send `/start` to the bot
in a private chat. The owner must be an administrator with permission to restrict members of the
configured group. Make the bot a group administrator with ban permissions so it receives group
messages and can execute confirmed bans. `PROTECTED_USER_IDS` optionally lists comma-separated
numeric IDs excluded from both suggested and confirmed bans. At startup the bot resolves
`OWNER_USERNAME` from Telegram administrators of the allowed groups and pins the numeric ID for
private notifications, assistant access, and confirmations. No `OWNER_USER_ID` configuration is needed.
The owner must be found in at least one allowed group; missing or conflicting identities fail startup.
After changing the owner username, update the configuration and restart the service.

Text messages, captions, and their received edits in the configured group are analyzed for unsolicited
advertising and suspicious promotion, including USDT offers and service advertisements disguised as
recommendations in comments. AI receives only group evidence: the current message, quoted reply,
up to 12 earlier messages by the same author across this group's topics, and observed message counts.
Missing history does not establish a new account: Telegram does not expose an account creation date.
History begins when moderation is enabled; existing conversation memory is not imported.

Suspicious cases produce a private notification with an excerpt, a source link where available,
the AI explanation, and **Ban permanently** / **Keep** buttons. No automatic bans, mutes, or message
deletions are performed. A confirmed permanent ban uses Telegram's `banChatMember`; in supergroups,
Telegram also deletes the banned participant's messages. Administrators, the owner, and configured
protected users cannot be recommended for a ban or banned. Actor permissions and target protection
are checked again immediately before the Telegram action. Anonymous/channel senders are excluded
because they cannot be safely treated as user accounts.

Decisions and pending reviews persist independently of `/reset`. Repeated updates and clicks do not
repeat bans. Received edits invalidate older reviews of that message. At most one active review is
sent per participant in a group; subsequent suspicious messages are recorded while that review is
pending. Reviews expire after seven days. On restart, unfinished analyses resume; ambiguous notification
or ban delivery is recorded as `unknown` and is never automatically repeated. A failed/ambiguous
notification may require manual inspection of the database; it does not authorize a ban.

Two analyses run concurrently with up to 64 queued/running cases. Queue overflow is recorded as
`overloaded` and is not analyzed or acted on. Each received eligible message can incur an OpenAI
request using `OPENAI_MODEL`; classification failures are retried up to three attempts. The queue is
checked every five seconds. Only one polling process is supported. Message text, reply text, author
labels, and classification explanations are removed after seven days by startup/hourly cleanup;
numeric participant IDs, first-observed dates, counts, and decision metadata remain for audit.
The current version has no statistics command or automated enforcement mode. Classification quality
must be assessed from real review decisions; mock tests cannot establish detection accuracy.

## Commands

- `pnpm dev` — run with reload.
- `pnpm build && pnpm start` — build and run production output.
- `pnpm db:generate` — generate the Prisma client.
- `pnpm db:migrate` — apply checked-in PostgreSQL migrations.
- `pnpm db:dev` — create a migration during development.
- `pnpm check` — typecheck, lint, formatting, tests, and agent-harness audit.
- `pnpm audit:agents` — check generated indexes, Markdown links, and local paths/links in source
  comments. External URLs and prose accuracy are not checked automatically.
- `pnpm sync:agents` — rebuild the rule and skill indexes in `AGENTS.md` from `ai/`.

Agent navigation starts in [AGENTS.md](AGENTS.md). Product and safety context lives in
[AGENT_CONTEXT.md](AGENT_CONTEXT.md).
