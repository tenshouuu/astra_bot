import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createMemory } from "@app/modules/memory/service";
import {
  HISTORY_BYTES,
  SUMMARY_BYTES,
  limitText,
  recentMessages,
} from "@app/modules/memory/context";
import type { MemoryStore, StoredMessage, Summary } from "@app/modules/memory/types";

function messages(count: number, text = "Synthetic message"): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: BigInt(index + 1),
    role: "user",
    author: "Test participant",
    text: `${text} ${index}`,
  }));
}

function fakeStore(pending: StoredMessage[]) {
  let summary: Summary = { text: "", throughId: 0n, version: 0 };
  let saves = 0;
  const store: MemoryStore = {
    append: async () => undefined,
    context: async () => ({
      summary,
      messages: pending.filter((message) => message.id > summary.throughId),
    }),
    pending: async () => ({
      summary,
      messages: pending.filter((message) => message.id > summary.throughId),
    }),
    saveSummary: async (_id, previous, text, throughId) => {
      if (previous.version !== summary.version) return;
      summary = { text, throughId, version: summary.version + 1 };
      saves++;
    },
    reset: async () => {
      summary = { text: "", throughId: 0n, version: summary.version + 1 };
      pending = [];
    },
    prune: async () => undefined,
  };
  return { store, summary: () => summary, saves: () => saves };
}

void test("context keeps recent messages within a byte budget without breaking Unicode", () => {
  const input = messages(20, "Привет😀".repeat(300));
  const context = recentMessages(input);
  assert.ok(context.length > 0 && context.length < input.length);
  assert.ok(
    context.reduce((total, item) => total + Buffer.byteLength(item.content), 0) <= HISTORY_BYTES,
  );
  assert.match(context.at(-1)?.content ?? "", /19/);
  assert.equal(limitText("а😀б", 6), "а😀");
});

void test("memory combines a bounded summary and the remaining recent messages", async () => {
  const state = fakeStore(messages(45));
  let calls = 0;
  const memory = createMemory(state.store, async (previous, batch) => {
    calls++;
    assert.equal(previous, "");
    assert.equal(batch.length, 33);
    return "Older decisions";
  });
  memory.refresh("group");
  await memory.close();
  assert.equal(calls, 1);
  assert.equal(state.summary().throughId, 33n);
  const context = await memory.context("group", "current");
  assert.match(context[0]?.content ?? "", /Older decisions/);
  assert.equal(context.length, 13);
});

void test("short conversations do not trigger an extra model request", async () => {
  const memory = createMemory(fakeStore(messages(5)).store, async () =>
    assert.fail("Unnecessary summary"),
  );
  memory.refresh("group");
  await memory.close();
});

void test("long messages trigger compaction even with a small message count", async () => {
  const state = fakeStore(messages(5, "x".repeat(7000)));
  const memory = createMemory(state.store, async () => "summary");
  memory.refresh("group");
  await memory.close();
  assert.equal(state.saves(), 1);
  assert.ok(state.summary().throughId > 0n);
});

void test("background jobs are serialized and a failed summary preserves the old cursor", async () => {
  const state = fakeStore(messages(45));
  let calls = 0;
  const memory = createMemory(state.store, async () => {
    calls++;
    throw new Error("Provider unavailable");
  });
  memory.refresh("group");
  memory.refresh("group");
  await memory.close();
  assert.equal(calls, 1);
  assert.equal(state.summary().throughId, 0n);
});

void test("summary output is bounded and reset clears both forms of memory", async () => {
  const state = fakeStore(messages(45));
  const memory = createMemory(state.store, async () => "а".repeat(4000));
  memory.refresh("group");
  await memory.reset("group");
  assert.equal(state.saves(), 1);
  assert.ok(Buffer.byteLength(state.summary().text) <= SUMMARY_BYTES);
  assert.deepEqual(await memory.context("group", "current"), []);
  await memory.close();
});

void test("context budgets account for JSON escaping of message contents", () => {
  const context = recentMessages(messages(3, "\u0000".repeat(8000)));
  assert.ok(context.length > 0);
  assert.ok(
    context.reduce((total, message) => total + Buffer.byteLength(message.content), 0) <=
      HISTORY_BYTES,
  );
});

void test("summarization bounds concurrency and queue across topics", async () => {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  const store = fakeStore(messages(45)).store;
  store.pending = async (id) => {
    started.push(id);
    return { summary: { text: "", throughId: 0n, version: 0 }, messages: messages(45) };
  };
  const memory = createMemory(store, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return "summary";
  });

  for (let index = 0; index < 100; index++) memory.refresh(`topic-${index}`);
  await setImmediate();
  assert.equal(started.length, 2);

  while (releases.length > 0) {
    for (const release of releases.splice(0)) release();
    await setImmediate();
  }
  assert.equal(peak, 2);
  assert.equal(started.length, 66);
  assert.equal(new Set(started).size, 66);

  // Overflow can be scheduled by a later refresh without losing persisted history.
  memory.refresh("topic-99");
  await setImmediate();
  assert.equal(started.at(-1), "topic-99");
  const closing = memory.close();
  for (const release of releases.splice(0)) release();
  await closing;
});

void test("shutdown discards queued summaries and drains active ones", async () => {
  let calls = 0;
  const releases: (() => void)[] = [];
  const memory = createMemory(fakeStore(messages(45)).store, async () => {
    calls++;
    await new Promise<void>((resolve) => releases.push(resolve));
    return "summary";
  });
  for (let index = 0; index < 20; index++) memory.refresh(`topic-${index}`);
  await setImmediate();

  const closing = memory.close();
  memory.refresh("after-close");
  for (const release of releases) release();
  await closing;
  assert.equal(calls, 2);
});

void test("failed summarization waits for retry cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
  let calls = 0;
  const memory = createMemory(fakeStore(messages(45)).store, async () => {
    if (++calls === 1) throw new Error("Synthetic provider failure");
    return "summary";
  });
  t.after(() => memory.close());

  memory.refresh("topic");
  await setImmediate();
  memory.refresh("topic");
  t.mock.timers.tick(29_999);
  await setImmediate();
  assert.equal(calls, 1);

  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls, 2);
});
