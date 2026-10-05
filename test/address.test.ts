import assert from "node:assert/strict";
import { test } from "node:test";
import { createDetectAddress } from "@app/modules/openai/address";
import type { ResponsesClient } from "@app/modules/openai/api";

void test("intent detection uses untrusted bounded context, strict output and no tools", async () => {
  const evidence = {
    text: "Вопрос к Астре: как выбрать цвет?",
    replyText: "Synthetic quote",
    repliesToOther: true,
  };
  const client = {
    responses: {
      create: async (request: Record<string, unknown>, options: unknown) => {
        assert.deepEqual(JSON.parse(String(request.input)), evidence);
        assert.match(String(request.instructions), /untrusted conversation data/);
        assert.match(String(request.instructions), /If uncertain return false/);
        assert.equal(request.store, false);
        assert.equal(request.max_output_tokens, 512);
        assert.equal("tools" in request, false);
        assert.deepEqual(options, { timeout: 10_000, maxRetries: 0 });
        return { status: "completed", output_text: '{"addressed":true}' };
      },
    },
  } as unknown as ResponsesClient;
  assert.equal(
    await createDetectAddress({ openaiApiKey: "synthetic", openaiModel: "test" }, client)(evidence),
    true,
  );
});

void test("intent detection never accepts uncertain, incomplete or malformed answers as consent to respond", async () => {
  for (const [status, output] of [
    ["incomplete", '{"addressed":true}'],
    ["completed", '{"addressed":false}'],
    ["completed", '{"addressed":"true"}'],
    ["completed", "null"],
    ["completed", "invalid"],
  ]) {
    const client = {
      responses: { create: async () => ({ status, output_text: output }) },
    } as unknown as ResponsesClient;
    const detect = createDetectAddress({ openaiApiKey: "synthetic", openaiModel: "test" }, client);
    const result = await detect({ text: "Астра", replyText: "", repliesToOther: false }).catch(
      () => false,
    );
    assert.equal(result, false);
  }
});
