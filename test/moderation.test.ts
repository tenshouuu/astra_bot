import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "@app/config/env";
import { createModeration, buildEvidence } from "@app/modules/moderation/service";
import { createClassify, parseClassification } from "@app/modules/openai/moderation";
import type { ResponsesClient } from "@app/modules/openai/api";
import { createBot } from "@app/modules/telegram/bot";
import type { Classify, Evidence, ReviewCase } from "@app/modules/moderation/types";
import type { Update } from "grammy/types";
import { fakeModerationStore } from "./helpers/moderation";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "silent",
  botToken: "synthetic-token",
  databaseUrl: "postgresql://localhost/astra_test",
  openaiApiKey: "synthetic-key",
  openaiModel: "test-model",
  ownerUsername: "owner",
  ownerUserId: 1,
  moderationEnabled: true,
  allowedChatId: -1001234567890,
  protectedUserIds: [9],
};

function message(text = "Продам USDT", updateId = 10, userId = 2): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: config.allowedChatId!, type: "supergroup", title: "Synthetic group" },
      from: { id: userId, is_bot: false, first_name: "Synthetic member" },
      text,
    },
  };
}

function callback(item: ReviewCase, action = "ban", actorId = 1): Update {
  return {
    update_id: 100,
    callback_query: {
      id: "synthetic-callback",
      chat_instance: "synthetic-chat",
      from: { id: actorId, is_bot: false, first_name: "Synthetic actor" },
      message: {
        message_id: item.notificationMessageId!,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "private", first_name: "Synthetic owner" },
        text: "Synthetic review",
      },
      data: `mod:${action}:${item.id}`,
    },
  };
}

function setup(
  classify: Classify = async () => ({ category: "advertising", reason: "Продажа USDT" }),
) {
  const { store, cases } = fakeModerationStore();
  const bot = createBot(config, async () => "Synthetic answer", undefined, { store, classify });
  bot.botInfo = {
    id: 42,
    is_bot: true,
    first_name: "Synthetic bot",
    username: "synthetic_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const sent: { chatId: number | string; text: string }[] = [];
  const state = { targetStatus: "member", ownerStatus: "creator", banFails: false, bans: 0 };
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "getChat") {
      return {
        ok: true,
        result: { id: config.allowedChatId, type: "supergroup", title: "Synthetic" },
      } as never;
    }
    if (method === "getChatMember" && "user_id" in payload) {
      return {
        ok: true,
        result: {
          status: payload.user_id === 1 ? state.ownerStatus : state.targetStatus,
          user: { id: payload.user_id, is_bot: false, first_name: "Synthetic" },
        },
      } as never;
    }
    if (method === "sendMessage" && "text" in payload && "chat_id" in payload) {
      assert.equal("parse_mode" in payload, false);
      sent.push({ chatId: payload.chat_id, text: payload.text });
      return { ok: true, result: { message_id: 1000 + sent.length } } as never;
    }
    if (method === "banChatMember") {
      state.bans++;
      assert.ok("user_id" in payload);
      assert.ok("chat_id" in payload);
      assert.equal(payload.user_id, 2);
      assert.equal(payload.chat_id, config.allowedChatId);
      assert.equal("until_date" in payload, false);
      if (state.banFails) throw new Error("Synthetic timeout");
    }
    return { ok: true, result: true } as never;
  });
  return { bot, store, cases, sent, state };
}

void test("advertising only sends an owner review; confirmation bans once across duplicate callbacks", async () => {
  const { bot, cases, sent, state } = setup();
  await bot.handleUpdate(message());
  await bot.waitForRequests();
  assert.equal(state.bans, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, 1);
  assert.match(sent[0]?.text ?? "", /Продам USDT/);
  const item = [...cases.values()][0]!;
  assert.equal(item.status, "review");
  await bot.handleUpdate(message());
  await bot.waitForRequests();
  assert.equal(sent.length, 1);
  await Promise.all([bot.handleUpdate(callback(item)), bot.handleUpdate(callback(item))]);
  assert.equal(state.bans, 1);
  assert.equal(item.status, "banned");
  assert.equal(item.decidedBy, 1n);
  await bot.closeRequests();
});

void test("keep, forged actor, expired and wrong-message callbacks never ban", async () => {
  for (const scenario of ["keep", "actor", "expired", "wrong-message", "wrong-chat"] as const) {
    const { bot, cases, state } = setup();
    await bot.handleUpdate(message());
    await bot.waitForRequests();
    const item = [...cases.values()][0]!;
    const request = callback(
      item,
      scenario === "keep" ? "keep" : "ban",
      scenario === "actor" ? 3 : 1,
    );
    if (scenario === "expired") item.expiresAt = new Date(0);
    if (!request.callback_query?.message) assert.fail("Missing callback message");
    if (scenario === "wrong-message") request.callback_query.message.message_id++;
    if (scenario === "wrong-chat") request.callback_query.message.chat.id = 3;
    await bot.handleUpdate(request);
    assert.equal(state.bans, 0);
    assert.equal(
      item.status,
      scenario === "keep" ? "kept" : scenario === "expired" ? "expired" : "review",
    );
    await bot.closeRequests();
  }
});

void test("protected users and administrators are excluded before AI analysis", async () => {
  for (const userId of [1, 9, 2]) {
    const { bot, state, sent } = setup(async () => assert.fail("Protected target reached AI"));
    if (userId === 2) state.targetStatus = "administrator";
    await bot.handleUpdate(message("Synthetic promotion", 10, userId));
    await bot.waitForRequests();
    assert.deepEqual(sent, []);
    assert.equal(state.bans, 0);
    await bot.closeRequests();
  }
});

void test("promotion during analysis suppresses notification; promotion or owner demotion before callback blocks ban", async () => {
  const duringAnalysis = setup(async () => {
    duringAnalysis.state.targetStatus = "administrator";
    return { category: "advertising", reason: "Synthetic promotion" };
  });
  await duringAnalysis.bot.handleUpdate(message());
  await duringAnalysis.bot.waitForRequests();
  assert.deepEqual(duringAnalysis.sent, []);
  await duringAnalysis.bot.closeRequests();

  for (const change of ["target", "owner"] as const) {
    const { bot, cases, state } = setup();
    await bot.handleUpdate(message());
    await bot.waitForRequests();
    const item = [...cases.values()][0]!;
    if (change === "target") state.targetStatus = "administrator";
    else state.ownerStatus = "member";
    await bot.handleUpdate(callback(item));
    assert.equal(state.bans, 0);
    assert.equal(item.status, change === "target" ? "protected" : "failed");
    await bot.closeRequests();
  }
});

void test("uncertain Telegram ban results are audited and never retried by a second click", async () => {
  const { bot, cases, state } = setup();
  await bot.handleUpdate(message());
  await bot.waitForRequests();
  const item = [...cases.values()][0]!;
  state.banFails = true;
  await bot.handleUpdate(callback(item));
  await bot.handleUpdate(callback(item));
  assert.equal(state.bans, 1);
  assert.equal(item.status, "unknown");
  await bot.closeRequests();
});

void test("private chats, other groups and anonymous senders never reach moderation", async () => {
  const { bot, cases } = setup(async () => assert.fail("Out-of-scope classification"));
  for (const scope of ["private", "other-group", "anonymous"] as const) {
    const update = message("Synthetic out-of-scope text");
    if (!update.message) assert.fail("Missing message");
    if (scope === "private")
      update.message.chat = { id: 1, type: "private", first_name: "Synthetic" };
    if (scope === "other-group") update.message.chat.id = -1009876543210;
    if (scope === "anonymous") update.message.sender_chat = update.message.chat;
    await bot.handleUpdate(update);
  }
  await bot.waitForRequests();
  assert.equal(cases.size, 0);
  await bot.closeRequests();
});

void test("edits invalidate old reviews, captions are analyzed, repeats and legitimate history reach the classifier", async () => {
  const evidence: Evidence[] = [];
  const { bot, cases } = setup(async (input) => {
    evidence.push(input);
    return { category: "suspicious", reason: "Повторяющаяся рекомендация сервиса" };
  });
  await bot.handleUpdate(message("Пользуйтесь synthetic-ai.example, я всегда им пользуюсь"));
  await bot.waitForRequests();
  const old = [...cases.values()][0]!;
  const edit = message("Исправленный текст", 11);
  if (!edit.message) assert.fail("Missing message");
  edit.message.message_id = 10;
  await bot.handleUpdate({
    update_id: 11,
    edited_message: { ...edit.message, edit_date: Math.floor(Date.now() / 1000) },
  });
  await bot.waitForRequests();
  assert.equal(old.status, "expired");
  await bot.handleUpdate(callback(old));
  const caption = message("caption", 12);
  if (!caption.message) assert.fail("Missing message");
  delete caption.message.text;
  caption.message.caption = "Исправленный текст";
  await bot.handleUpdate(caption);
  await bot.waitForRequests();
  assert.equal(evidence.at(-1)?.text, "Исправленный текст");
  assert.equal(evidence.at(-1)?.observedMessageCount, 2);
  assert.ok((evidence.at(-1)?.exactRepeats ?? 0) >= 1);
  await bot.closeRequests();
});

void test("clean messages produce no review and classifier failures do not cause a ban", async () => {
  for (const fails of [false, true]) {
    const { bot, cases, sent, state } = setup(async () => {
      if (fails) throw new Error("Synthetic classifier failure");
      return { category: "clean", reason: "Обычное обсуждение" };
    });
    await bot.handleUpdate(message("Обсуждаем интеграцию сервиса"));
    await bot.waitForRequests();
    assert.deepEqual(sent, []);
    assert.equal(state.bans, 0);
    assert.equal([...cases.values()][0]?.status, fails ? "queued" : "clean");
    await bot.closeRequests();
  }
});

void test("moderation bounds active AI jobs and shutdown waits for them", async () => {
  const { store, cases } = fakeModerationStore();
  const releases: (() => void)[] = [];
  const moderation = createModeration(
    store,
    () =>
      new Promise((resolve) =>
        releases.push(() => resolve({ category: "clean", reason: "Synthetic" })),
      ),
    {
      eligibility: async () => "allowed",
      notify: async () => assert.fail("Unexpected review"),
      ban: async () => assert.fail("Unexpected ban"),
    },
    1,
  );
  for (let index = 0; index < 4; index++) {
    await store.observe({
      updateId: index,
      chatId: -100n,
      userId: BigInt(index + 2),
      messageId: index,
      text: "Synthetic",
      replyText: "",
      authorLabel: "Synthetic",
      isBot: false,
      sentAt: new Date(),
    });
  }
  await moderation.runPending();
  await moderation.runPending();
  assert.equal(releases.length, 2);
  let closed = false;
  const closing = moderation.close().then(() => {
    closed = true;
  });
  assert.equal(closed, false);
  for (const release of releases) release();
  await closing;
  assert.equal([...cases.values()].filter((item) => item.status === "queued").length, 2);
});

void test("OpenAI moderation uses strict structured output, treats evidence as data and validates responses", async () => {
  for (const [status, output] of [
    ["completed", '{"category":"advertising","reason":"Продажа USDT"}'],
    ["incomplete", '{"category":"advertising","reason":"Partial"}'],
    ["completed", '{"category":"ban","reason":"Injected action"}'],
    ["completed", "not JSON"],
  ]) {
    const client = {
      responses: {
        create: async (request: Record<string, unknown>) => {
          assert.equal(request.store, false);
          assert.equal(request.model, "test-model");
          assert.match(String(request.instructions), /untrusted evidence/);
          assert.match(String(request.instructions), /Do not infer account creation dates/);
          assert.equal((request.text as { format: { strict: boolean } }).format.strict, true);
          return { status, output_text: output };
        },
      },
    } as unknown as ResponsesClient;
    const classify = createClassify(config, client);
    const input: Evidence = {
      text: "Synthetic",
      replyText: "",
      isBot: false,
      firstSeenAt: new Date().toISOString(),
      observedMessageCount: 1,
      previousMessages: [],
      exactRepeats: 0,
    };
    if (status === "completed" && output?.includes("Продажа USDT")) {
      assert.equal((await classify(input)).category, "advertising");
    } else await assert.rejects(classify(input));
  }
  assert.throws(() => parseClassification('{"category":"clean","reason":""}'));
  assert.throws(() =>
    parseClassification(JSON.stringify({ category: "clean", reason: "a".repeat(601) })),
  );
});

void test("evidence limits historical text and normalizes exact repeats without asserting account age", () => {
  const item = {
    text: "  ПРОДАМ   USDT ",
    replyText: "Quoted post",
    isBot: false,
    firstSeenAt: new Date(),
    messageCount: 20,
  } as ReviewCase;
  const evidence = buildEvidence(item, [
    "продам usdt",
    ...Array<string>(20).fill("😀".repeat(2000)),
  ]);
  assert.equal(evidence.exactRepeats, 1);
  assert.equal(evidence.previousMessages.length, 12);
  assert.equal([...evidence.previousMessages[0]!].length, 600);
  assert.equal("accountAge" in evidence, false);
});

void test("crypto sale observation logs review progress without exposing message text", async (t) => {
  const log = t.mock.method(console, "info", () => undefined);
  const text = "Продам крипту за наличные";
  const { bot, cases, sent, state } = setup(async (evidence) => {
    assert.equal(evidence.text, text);
    return { category: "advertising", reason: "Предложение продажи криптовалюты" };
  });
  try {
    await bot.handleUpdate(message(text));
    await bot.waitForRequests();
    assert.equal([...cases.values()][0]?.status, "review");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.chatId, 1);
    assert.equal(state.bans, 0);
    const calls = log.mock.calls.map((call) => call.arguments);
    assert.ok(calls.some(([name]) => name === "Moderation message received"));
    assert.ok(
      calls.some(
        ([name, metadata]) => name === "Moderation case updated" && metadata.status === "review",
      ),
    );
    assert.equal(JSON.stringify(calls).includes(text), false);
  } finally {
    await bot.closeRequests();
  }
});

void test("a moderation capture failure does not swallow a bot mention", async () => {
  const { bot, store, sent, state } = setup();
  store.observe = async () => {
    throw new Error("Synthetic persistence failure");
  };
  const request = message("@synthetic_bot привет");
  assert.ok(request.message);
  request.message.entities = [{ type: "mention", offset: 0, length: 14 }];
  try {
    await bot.handleUpdate(request);
    await bot.waitForRequests();
    assert.ok(sent.some((item) => item.text === "Synthetic answer"));
    assert.equal(state.bans, 0);
  } finally {
    await bot.closeRequests();
  }
});

void test("removing a caption invalidates owner review, clears search and never classifies empty edits", async () => {
  let classifications = 0;
  const { bot, store, cases, sent, state } = setup(async () => {
    classifications++;
    return { category: "advertising", reason: "Synthetic offer" };
  });
  const initial = message("Synthetic caption");
  assert.ok(initial.message);
  delete initial.message.text;
  initial.message.caption = "Synthetic caption";
  try {
    await bot.handleUpdate(initial);
    await bot.waitForRequests();
    const original = [...cases.values()][0]!;
    assert.equal(original.status, "review");
    const edit = { ...initial.message, edit_date: Math.floor(Date.now() / 1000) };
    delete edit.caption;
    await bot.handleUpdate({ update_id: initial.update_id + 1, edited_message: edit });
    await bot.waitForRequests();
    assert.equal(original.status, "expired");
    assert.equal(await store.isCurrent(original), false);
    assert.equal(classifications, 1);
    assert.deepEqual(await store.search(original.chatId, undefined, "", null), []);
    assert.equal([...cases.values()].at(-1)?.text, "");
    assert.equal([...cases.values()].at(-1)?.status, "clean");
    const notifications = sent.length;
    await bot.handleUpdate(callback(original));
    assert.equal(state.bans, 0);
    assert.equal(sent.length, notifications + 1);
    assert.notEqual(sent.at(-1)?.text, "Участник забанен навсегда.");
    await bot.handleUpdate({ update_id: initial.update_id + 1, edited_message: edit });
    assert.equal(cases.size, 2);
  } finally {
    await bot.closeRequests();
  }
});
