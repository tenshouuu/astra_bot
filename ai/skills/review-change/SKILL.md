---
name: review-change
description: Review Astra Bot code or architecture for defects, moderation safety, regressions, and missing verification without implementing unrelated changes.
---

# Review a change

Use the [reviewer role](../../roles/reviewer.md). Load `ai/rules/code-readability.mdc` when reviewing code. For moderation or access boundaries,
also load the [safety specialist role](../../roles/moderation-engineer.md) and
`ai/rules/moderation-safety.mdc`. Read `AGENT_CONTEXT.md`, the changed files, and the
rules whose globs match them. Prioritize exploitable authorization gaps, possible bans of protected or
admin users, non-idempotent callbacks, secret exposure, and misleading readiness claims.

Run targeted read-only checks when useful. Present findings in severity order with file locations,
impact, and a concrete remediation. Distinguish verified defects from questions or future hardening.
