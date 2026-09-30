# AI harness

This directory is the canonical, tool-neutral context for coding agents.

## Map

- [Project context](../AGENT_CONTEXT.md) is the single source of product and architecture context.
- `rules/` contains always-on and path-scoped constraints.
- `skills/` contains task workflows; load only the skill that matches the request.
- `roles/` describes the perspective and responsibilities selected by a skill.
- `dev/` is the only location for temporary plans, review notes, investigations, and architecture
  drafts. Its content is non-authoritative and may be deleted after the work is complete.

The root [AGENTS.md](../AGENTS.md) is the entrypoint. Change canonical sources here, then run
`pnpm sync:agents`; validate navigation and local links with `pnpm audit:agents`.
