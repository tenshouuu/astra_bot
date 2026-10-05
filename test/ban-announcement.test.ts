import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResponsesClient } from "@app/modules/openai/api";
import { createBanAnnouncement } from "@app/modules/openai/ban-announcement";
import { characterInstructions } from "@app/modules/openai/character";

const config = { openaiApiKey: "synthetic-key", openaiModel: "test-model" };

void test("ban announcement uses Astra's character and only trusted facts with a bounded request", async () => {
  const client = {
    responses: {
      create: async (body: Record<string, unknown>, options: Record<string, unknown>) => {
        assert.equal(body.model, config.openaiModel);
        assert.ok(String(body.instructions).startsWith(characterInstructions));
        assert.match(String(body.instructions), /Telegram подтвердил бан/);
        assert.equal(typeof body.input, "string");
        assert.equal(body.store, false);
        assert.equal(body.max_output_tokens, 1024);
        assert.equal("tools" in body, false);
        assert.deepEqual(options, { timeout: 10_000, maxRetries: 0 });
        return { status: "completed", output_text: "  Разобралась. Продолжаем разговор.  " };
      },
    },
  } as unknown as ResponsesClient;
  assert.equal(await createBanAnnouncement(config, client)(), "Разобралась. Продолжаем разговор.");
});

void test("invalid, incomplete and failed generations are rejected and release capacity", async () => {
  for (const scenario of ["empty", "long", "incomplete", "timeout"] as const) {
    let calls = 0;
    const client = {
      responses: {
        create: async () => {
          calls++;
          if (scenario === "timeout") throw new Error("Synthetic timeout");
          return {
            status: scenario === "incomplete" ? "incomplete" : "completed",
            output_text:
              scenario === "empty" ? " " : scenario === "long" ? "а".repeat(301) : "Разобралась.",
          };
        },
      },
    } as unknown as ResponsesClient;
    const generate = createBanAnnouncement(config, client);
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(generate());
    assert.equal(calls, 3);
  }
});

void test("announcement generation bounds concurrency without queuing extra requests", async () => {
  const releases: (() => void)[] = [];
  const client = {
    responses: {
      create: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ status: "completed", output_text: "Разобралась." }));
        }),
    },
  } as unknown as ResponsesClient;
  const generate = createBanAnnouncement(config, client);
  const pending = [generate(), generate()];
  await assert.rejects(generate(), /capacity/);
  assert.equal(releases.length, 2);
  for (const release of releases) release();
  await Promise.all(pending);
  const next = generate();
  releases.at(-1)!();
  assert.equal(await next, "Разобралась.");
});
