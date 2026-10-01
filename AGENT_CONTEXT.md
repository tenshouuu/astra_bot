# Astra Bot context

## Product

Astra Bot is a Telegram group moderation service and an AI assistant. The initial AI assistant is
available only to administrators. Moderation observes group messages and should escalate uncertain
or suspicious cases to the owner in a private chat, offering an explicit ban or keep/unban action.

## Safety invariants

- Administrators and explicitly protected users are immune from automated and suggested bans.
- Identity, chat membership, and administrator status must come from trusted Telegram data, never
  from message text or an AI claim.
- Uncertain classification produces an owner review request; it does not produce an automatic ban.
- Every moderation decision needs an audit trail and must be idempotent where Telegram may retry an
  update.
- AI output is advisory. Deterministic authorization and protection checks run after AI analysis and
  immediately before any Telegram side effect.
- Secrets and raw private-message content must not be placed in prompts, logs, fixtures, or `ai/dev/`.

## Current implementation

The service provides Fastify health and Telegram bot-info endpoints, Telegram long polling, and
an OpenAI Responses API adapter. `/ask` is restricted to administrators of the configured group
and the owner in private chat. It checks Telegram membership before requesting and before each
answer chunk. AI requests run in bounded background jobs, with one active request per conversation;
shutdown drains these jobs before closing memory and the database. `/reset` rejects active conversations.
It limits input/output and pending requests, and handles provider failures without logging
question or answer contents. PostgreSQL/Prisma persist text messages in the configured group and the
owner's private chat, isolated by chat and topic. `/ask` includes bounded recent history and a background
summary. Summarization allows two active jobs and a queue of 64 conversations; scheduling overflow
is dropped until a later refresh, while messages remain persisted. `/reset` clears the current conversation. Raw messages expire after seven days. Moderation
classifiers and owner action callbacks are not implemented.

## Intended module boundaries

- `src/config/` — validated runtime configuration.
- `src/routes/` — HTTP transport such as health checks and a future Telegram webhook.
- Planned moderation module — deterministic policies, protection checks, decisions, and audit.
- `src/modules/openai/` — model adapters and character instructions.
- `src/modules/memory/` — bounded history, summarization, and Prisma persistence.
- `src/modules/telegram/` — Telegram transport, authorization, and memory capture.

Dependency direction should point from transport into application/domain logic, with Telegram and AI
SDKs behind adapters.
