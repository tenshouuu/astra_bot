---
name: implement-service-slice
description: Implement or change a Fastify backend slice in Astra Bot, including Telegram, moderation, assistant, configuration, or HTTP behavior.
---

# Implement a service slice

Use the [backend engineer role](../../roles/backend-engineer.md). For moderation, Telegram actions, or
assistant authorization, also use the [moderation engineer role](../../roles/moderation-engineer.md)
and load `ai/rules/moderation-safety.mdc`.

Start from `AGENT_CONTEXT.md`. Identify the trusted input boundary and the
last external side effect. Keep policy independent of Fastify and provider SDKs, add focused tests for
observable behavior and safety invariants, then run the checks required by `ai/rules/checks.mdc`.

If the work requires an undecided provider or irreversible product policy, implement only the stable
boundary and record the decision needed rather than inventing credentials or production behavior.
