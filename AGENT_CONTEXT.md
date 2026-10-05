# Astra Bot context

## Product

Astra Bot is a Telegram group moderation service and an AI assistant. The assistant answers current
group administrators when addressed through `/ask`, a reply to its message, a Telegram mention, or a
semantically confirmed direct address using Astra/Астра or an inflected name.
Chat management is reserved for the owner/administrators. Moderation observes group messages and should escalate uncertain
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
an OpenAI Responses API adapter. `/ask`, replies to the bot, mentions and name addresses use one bounded request
handler. The shared character prompt targets one or two short phrases (usually up to 30 words) for
casual chat, with detail on request or when needed. It encourages contextual humor, avoids repeated
caveats and invented explanations for missed replies, and retains concise responses to concrete danger.
Conversation access is limited to current group administrators and the owner in private chat;
ordinary members are silently ignored before conversation/intent AI calls, including commands, replies,
mentions, names and continuations. `/ping` and `/reset` are also restricted; `/chatid` is available to
administrators even before group allowlisting. Background moderation and memory capture still observe
all group participants.
Management access is checked separately and `/reset` remains administrator/owner-only.
Conversation responses cannot invoke moderation actions. Telegram administrator status is checked before requesting and before each
answer chunk. AI requests run in bounded background jobs, with one active request per conversation;
shutdown drains these jobs before closing memory and the database. `/reset` rejects active conversations.
Backend tools expose common chat info/member count and caller-bound profile/message search to
administrators; ordinary members cannot execute even these tools.
Inspection of others and broader message search require live administrator rights, independently of
whether moderation is enabled. Review requests still require enabled moderation and owner confirmation.
Administrator rights in the selected group are checked before/after restricted reads and before each
answer chunk using their results. Group callers see only their current group in the tool scope.
The assistant is instructed to refuse member-requested profiling/investigations naturally, without
reconstructing restricted reports from conversation context; public-topic discussion is currently administrator-only.
Name candidates use an AI intent check inside those jobs (10-second timeout, no retries, 512 tokens),
before typing or answering. It distinguishes direct address from third-person/quoted references;
uncertainty, errors and overload stay silent. Code, links, Telegram quotes and forwards are excluded.
Successful assistant answers open a two-minute continuation window per chat/topic. A separate AI
intent check may accept an untagged reply from any current administrator, using up to six recent turns
with speaker IDs and 600 characters each. Unrelated human messages do not renew the window; closing
acknowledgments end it. Detection uses existing job limits, 10 seconds, 512 tokens and no retries.
Every continuation creates fresh tool permissions for its author. Windows are memory-only, bounded
to 64 scopes with lazy expiry and cleared on reset/shutdown; failed delivery does not open a window.
It limits input/output and pending requests, and handles provider failures without logging
question or answer contents. PostgreSQL/Prisma persist text messages in the configured groups and the
owner's private chat, isolated by chat and topic. `/ask` includes bounded recent history and a background
summary. Summarization allows two active jobs and a queue of 64 conversations; scheduling overflow
is dropped until a later refresh, while messages remain persisted. `/reset` clears the current conversation. Raw messages expire after seven days. Moderation
observes group text/captions and edits when explicitly enabled. A structured AI classifier considers
bounded per-user group evidence, USDT offers, and disguised service promotion. It distinguishes clear
spam-like patterns, advertising, ambiguous posts and creative event announcements; prior genuine
conversation lowers suspicion and must be considered in the explanation. Creative events are sent
for coordination without recommending punishment. Event/ambiguous reviews put keeping the participant
first, while any ban still requires explicit owner confirmation. Suspicious cases are
sent privately to a numeric owner ID resolved from `OWNER_USERNAME` via Telegram group administrators with permanent-ban/keep callbacks; automatic enforcement
is not implemented. PostgreSQL stores participant observation counts, seven-day raw evidence, review
states, and durable audit metadata independently of conversation reset. Two analyses run at once with
64 queued/running cases; overflow is audited and skipped. Received edits, including deletion of a media caption, invalidate old reviews and
one active review is allowed per participant. Reviews expire after seven days. Startup resumes analyses
but never repeats ambiguous notification/ban delivery. Owner permissions and target protections are
checked immediately before each confirmed ban. Bans explicitly revoke only the target participant's
messages in the group. After persisting the ban, the bot separately removes only the source message
using deleteMessages (which skips already absent messages), rechecking owner deletion rights and
target protection within Telegram's 48-hour deletion window. Cleanup failure leaves the ban confirmed,
is logged without message content, and is reported to the owner without claiming deletion; duplicate
callbacks never repeat cleanup or the ban. The owner confirmation reports only the source message's
removal, not the entire user's history. The bot then attempts one silent, varied announcement
in the source topic, without identities or evidence; announcement failure never retries the ban.
Announcement text is generated using the shared Astra character and only the confirmed ban, without
claiming message deletion. It targets an upbeat 5–15-word quip about Astra's satisfaction with her
work, without celebrating punishment, counting removed participants, inventing a ban reason, or
asking the group to resume a conversation. Generation uses
two concurrent requests at most, a 10-second timeout, no retries, and a short fallback in the same tone.
Owner permissions are rechecked after generation and before sending.
Moderation requires the owner to start the private bot
chat and both owner/bot to have moderation permissions. Telegram does not expose account age;
first-seen metadata describes only this bot's observations.

## Intended module boundaries

- `src/config/` — validated runtime configuration.
- `src/routes/` — HTTP transport such as health checks and a future Telegram webhook.
- `src/modules/moderation/` — review workflow, bounded analysis jobs, decisions, and audit persistence.
- `src/modules/openai/` — model adapters and character instructions.
- `src/modules/memory/` — bounded history, summarization, and Prisma persistence.
- `src/modules/telegram/` — Telegram transport, authorization, and memory capture.

Dependency direction should point from transport into application/domain logic, with Telegram and AI
SDKs behind adapters.

`ALLOWED_CHAT_ID` accepts a comma-separated allowlist of negative group IDs (one ID is also supported).
IDs take precedence over the public username fallback. Authorization and moderation share the same
allowlist; assistant tools in a group remain scoped to its chat/topic. With multiple groups, owner-private
tools require an explicit allowed chat ID, preventing implicit selection of a different group.

Moderation startup resolves `OWNER_USERNAME` from allowed group administrators, requiring one unique
account. Its numeric ID is fixed for that running bot and used for private delivery, protection, and
confirmation checks. `OWNER_USER_ID` is no longer read from the environment.
