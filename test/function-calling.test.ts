import assert from "node:assert/strict";
import { test } from "node:test";
import { createAsk, type ResponsesClient } from "@app/modules/openai/api";
import type { AssistantRuntime } from "@app/modules/openai/tools";

const config = { openaiApiKey: "synthetic-key", openaiModel: "test-model" };
const tool = {
  name: "get_chat_info",
  description: "Synthetic read",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};
function call(callId = "call_1", name = tool.name, args = "{}") {
  return { type: "function_call", name, call_id: callId, arguments: args };
}
function clientWith(create: (request: Record<string, unknown>) => unknown): ResponsesClient {
  return {
    responses: { create: async (request: Record<string, unknown>) => create(request) },
  } as unknown as ResponsesClient;
}

void test("Responses tool loop advertises strict tools and replays reasoning plus matched function results", async () => {
  const requests: Record<string, unknown>[] = [];
  let executions = 0;
  const runtime: AssistantRuntime = {
    tools: [tool],
    requestContext: { actor_id: 2 },
    execute: async (name, args) => {
      executions++;
      assert.equal(name, tool.name);
      assert.deepEqual(args, {});
      return { title: "Synthetic group" };
    },
  };
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "synthetic-encrypted-reasoning",
  };
  const client = clientWith((request) => {
    requests.push(structuredClone(request));
    return requests.length === 1
      ? { status: "completed", output_text: "", output: [reasoning, call()] }
      : { status: "completed", output_text: "Нашла группу", output: [] };
  });
  assert.equal(await createAsk(config, client)("Что ты умеешь?", [], runtime), "Нашла группу");
  assert.equal(executions, 1);
  assert.equal(requests[0]?.store, false);
  assert.equal(requests[0]?.parallel_tool_calls, false);
  assert.deepEqual(requests[0]?.tools, [{ ...tool, type: "function", strict: true }]);
  assert.match(String(requests[0]?.instructions), /owner confirmation/);
  assert.match(String(requests[0]?.instructions), /targeted activity\/history reports/);
  assert.match(String(requests[0]?.instructions), /Do not reconstruct a restricted report/);
  assert.match(String(requests[0]?.instructions), /natural response in Astra's voice/);
  assert.deepEqual((requests[1]?.input as unknown[]).slice(1), [
    reasoning,
    call(),
    { type: "function_call_output", call_id: "call_1", output: '{"title":"Synthetic group"}' },
  ]);
  assert.equal("previous_response_id" in requests[1]!, false);
});

void test("unknown tools, malformed arguments and executor failures return bounded errors without raw exception text", async () => {
  for (const scenario of ["unknown", "invalid-json", "failure", "oversized"] as const) {
    let executions = 0;
    let requests = 0;
    const runtime: AssistantRuntime = {
      tools: [tool],
      requestContext: {},
      execute: async () => {
        executions++;
        if (scenario === "failure") throw new Error("synthetic-private-error-text");
        return "x".repeat(9000);
      },
    };
    const client = clientWith((request) => {
      if (++requests === 1)
        return {
          status: "completed",
          output_text: "",
          output: [
            call(
              "call_1",
              scenario === "unknown" ? "ban_without_confirmation" : tool.name,
              scenario === "invalid-json" ? "not JSON" : "{}",
            ),
          ],
        };
      const result = (request.input as { output?: string }[]).at(-1)?.output ?? "";
      assert.equal(result.includes("synthetic-private-error-text"), false);
      assert.equal(
        JSON.parse(result).error,
        scenario === "unknown"
          ? "unknown_tool"
          : scenario === "oversized"
            ? "tool_result_too_large"
            : "tool_failed",
      );
      return { status: "completed", output_text: "Не получилось", output: [] };
    });
    await createAsk(config, client)("Synthetic", [], runtime);
    assert.equal(executions, scenario === "unknown" || scenario === "invalid-json" ? 0 : 1);
  }
});

void test("function calls are sequential and bounded; duplicate IDs and calls on final round do not execute", async () => {
  for (const scenario of ["parallel", "duplicate", "budget"] as const) {
    let requests = 0;
    let executions = 0;
    const runtime: AssistantRuntime = {
      tools: [tool],
      requestContext: {},
      execute: async () => {
        executions++;
        return {};
      },
    };
    const client = clientWith((request) => {
      requests++;
      if (requests === 3) assert.equal(request.tool_choice, "none");
      return {
        status: "completed",
        output_text: "",
        output:
          scenario === "parallel"
            ? [call("one"), call("two")]
            : [call(scenario === "duplicate" ? "same" : `call_${requests}`)],
      };
    });
    await assert.rejects(createAsk(config, client)("Synthetic", [], runtime));
    assert.equal(executions, scenario === "parallel" ? 0 : scenario === "duplicate" ? 1 : 2);
    assert.equal(requests, scenario === "parallel" ? 1 : scenario === "duplicate" ? 2 : 3);
  }
});

void test("oversized accumulated inputs and unavailable function runtimes fail before execution", async () => {
  let requests = 0;
  const client = clientWith(() => {
    requests++;
    return { status: "completed", output_text: "", output: [call()] };
  });
  await assert.rejects(createAsk(config, client)("x".repeat(64_001)));
  assert.equal(requests, 0);
  await assert.rejects(createAsk(config, client)("Synthetic"));
  assert.equal(requests, 1);
});
