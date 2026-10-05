import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResponsesClient } from "@app/modules/openai/api";
import { createDetectContinuation } from "@app/modules/openai/continuation";

void test("continuation classification preserves speaker attribution and rejects uncertain outputs", async () => {
  const evidence = {
    text: "Почему именно тёплые?",
    authorId: 3,
    replyText: "",
    repliesToOther: false,
    recentTurns: [
      { authorId: 1, text: "Что выбрать?" },
      { authorId: null, text: "Тёплые цвета." },
    ],
  };
  for (const [status, output, expected] of [
    [
      "completed",
      '{"addressed":true,"closesConversation":false}',
      { addressed: true, closesConversation: false },
    ],
    [
      "completed",
      '{"addressed":true,"closesConversation":true}',
      { addressed: true, closesConversation: true },
    ],
    [
      "completed",
      '{"addressed":false,"closesConversation":true}',
      { addressed: false, closesConversation: false },
    ],
    [
      "completed",
      '{"addressed":"true","closesConversation":false}',
      { addressed: false, closesConversation: false },
    ],
    [
      "incomplete",
      '{"addressed":true,"closesConversation":false}',
      { addressed: false, closesConversation: false },
    ],
  ] as const) {
    const client = {
      responses: {
        create: async (request: Record<string, unknown>, options: unknown) => {
          assert.deepEqual(JSON.parse(String(request.input)), evidence);
          assert.match(
            String(request.instructions),
            /Different numeric authors are different people/,
          );
          assert.match(String(request.instructions), /untrusted conversation data/);
          assert.equal(request.store, false);
          assert.equal(request.max_output_tokens, 512);
          assert.equal("tools" in request, false);
          assert.deepEqual(options, { timeout: 10_000, maxRetries: 0 });
          return { status, output_text: output };
        },
      },
    } as unknown as ResponsesClient;
    const detect = createDetectContinuation(
      { openaiApiKey: "synthetic", openaiModel: "test-model" },
      client,
    );
    assert.deepEqual(await detect(evidence), expected);
  }
});
