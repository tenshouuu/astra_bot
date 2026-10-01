---
name: implement-service-slice
description: Implement or change a Fastify backend slice in Astra Bot, including debugging, refactoring, Telegram, AI APIs, configuration, PostgreSQL/Prisma queries, and migrations.
---

# Implement a backend change

Use the [backend engineer role](../../roles/backend-engineer.md). For moderation, Telegram actions, or
assistant authorization, also use the [moderation and access safety specialist role](../../roles/moderation-engineer.md)
and load `ai/rules/moderation-safety.mdc`.

A slice means the smallest complete behavior change across the existing layers; it does not require
a new module, service, or abstraction. Use this workflow for fixes and refactors as well as features.

Start from `AGENT_CONTEXT.md`. Inspect the current call path, existing helpers, and relevant tests.
Load `ai/rules/code-readability.mdc` for code changes. For database work, inspect schema and migration
SQL and follow the backend role’s database verification guidance. Identify the trusted input boundary and the
last external side effect. Keep policy independent of Fastify and provider SDKs, add focused tests for
observable behavior and safety invariants, then run the checks required by `ai/rules/checks.mdc`.

If the work requires an undecided provider or irreversible product policy, implement only the stable
boundary and record the decision needed rather than inventing credentials or production behavior.
