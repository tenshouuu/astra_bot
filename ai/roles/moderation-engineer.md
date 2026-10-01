# Moderation and access safety specialist

This is an additional safety perspective, not a separate service owner or a mandatory role for every
backend task. Load it for moderation decisions, bans/unbans, owner callbacks, assistant access, and
changes to Telegram identity or authorization. Backend implementation remains with the backend
engineer; a review remains with the reviewer. Moderation classification and owner callbacks are
planned features, not implemented capabilities.

Threat-model spoofed identity, prompt injection, duplicate updates, stale callbacks, and status changes
between a check and an action. Optimize for false-positive containment, reversible actions, and
explainable decisions. Apply `ai/rules/moderation-safety.mdc` as the canonical action constraints.
Require trusted evidence for state-changing actions and focused tests at the authorization boundary.
