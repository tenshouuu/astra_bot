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

The repository currently contains the Fastify/TypeScript service bootstrap, configuration loading,
health endpoints, and quality tooling. Telegram transport, persistence, moderation classifiers, AI
providers, and owner action callbacks are planned boundaries, not implemented features.

## Intended module boundaries

- `src/config/` — validated runtime configuration.
- `src/routes/` — HTTP transport such as health checks and a future Telegram webhook.
- Future Telegram module — Telegram update parsing and API adapter.
- Future moderation module — deterministic policies, protection checks, decisions, and audit.
- Future assistant module — admin-only assistant orchestration and model adapters.

Dependency direction should point from transport into application/domain logic, with Telegram and AI
SDKs behind adapters.
