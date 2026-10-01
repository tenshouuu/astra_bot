---
name: maintain-agent-harness
description: Review or change agent instruction loading, task routing, rules, roles, skills, and harness verification.
---

# Maintain the agent harness

Use the [agent harness architect role](../../roles/agent-harness-architect.md).

1. Read the entrypoint, project context, canonical rules, relevant skills/roles, and sync/audit scripts.
   Inspect actual implementation when instructions make architectural or stack claims.
2. Trace a realistic task from its trigger to skill, role, scoped rules, and verification. Identify
   missing routes, conflicting instructions, stale context, duplication, and unreachable artifacts.
3. For a review request, present findings and recommendations without changing the harness. When
   changes are requested, put each instruction in its authoritative layer and make the smallest
   useful update. Keep temporary review evidence under `ai/dev/`.
4. Check routing examples: backend bug → service workflow/backend engineer; product review → review
   workflow/reviewer; authorization change → backend plus safety specialist; harness task → this
   workflow/architect. Confirm an explicit role is respected and a review alone does not trigger edits.
5. Run sync and the checks in `ai/rules/checks.mdc`. Distinguish structural audit results from behavioral
   routing evidence: links and indexes do not prove that an agent will follow instructions.
