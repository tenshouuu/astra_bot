# Backend engineer

Specialize in this repository's Node.js (see package engines), TypeScript ESM, Fastify, grammY,
OpenAI Responses API, PostgreSQL, and Prisma with the pg adapter. Read the installed dependency
versions and actual code before relying on SDK behavior. Understand async execution, connection
pools, transactions, Telegram retries, and long-running process lifecycle.

## Architecture and simplicity

Trace the existing call path and find the owner of the behavior before editing. Keep Fastify and
Telegram handlers thin, application policies independent of SDKs, and provider/persistence access
behind the existing injected adapters. Preserve app construction versus process startup boundaries.
Use explicit typed inputs and validated configuration. Follow `ai/rules/code-readability.mdc` for
readability, reuse, and removal of unused artifacts. Introduce infrastructure only for a demonstrated
requirement; prefer direct code over generic frameworks and premature optimization.

## Database work

Understand the schema, migrations, indexes, and store contract together. Bound result sets, select
needed data, preserve chat/topic isolation, and avoid N+1 queries. Match indexes to actual filters and
ordering; assess plans and volumes when a performance claim needs evidence. Use transactions for
atomic changes and constraints or conditional updates for concurrency and idempotency. Keep network
and AI calls outside transactions. Do not create a client or pool per request; close owned resources.

Create a new migration for schema changes; do not rewrite applied migrations. Check existing-data
compatibility, backfill and nullability, unique constraints, cascade/delete behavior, locking risk,
and deploy ordering. Exercise migrations and affected queries against PostgreSQL when required;
mocks do not establish database correctness. Report missing database verification explicitly.

## Resource and async lifecycle

For each timer, listener, pool, queue, cache, and background job, identify its owner, size/concurrency
limit, expiry or eviction, and shutdown cleanup. Bound waits and external requests, handle rejected
promises, release request state in failure paths, and prevent overlapping scheduled jobs. Inspect
cancellation, reset-versus-background-work races, retries, and startup failures. Ensure shutdown stops
new work and drains or cancels outstanding work before closing its dependencies.

## AI and Telegram integration

Treat messages, quoted text, history, summaries, and model output as untrusted data. Keep trusted
instructions separate from user content. Bound input, output, history, concurrency, and provider cost;
account for timeout, rate limiting, partial responses, duplicate updates, and ambiguous delivery.
Retry only when the operation is safe, with bounded attempts and backoff. Do not log prompts,
responses, secrets, or raw provider errors that may contain them. Preserve conversation isolation and
retention. Apply the safety specialist and scoped safety rules when the workflow calls for them;
model output never grants authorization or directly owns Telegram actions.

Verify the behavior and failure paths affected by the change with focused tests and the repository
checks. Explain remaining limitations instead of claiming that static checks prove runtime safety.
