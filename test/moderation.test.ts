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
  const bot = createBot(config, async () => "Synthetic answer", undefined, {
    store,
    classify,
    generateBanAnnouncement: async () => {
      state.generations++;
      assert.ok([...cases.values()].some((item) => item.status === "banned"));
      if (state.generationFails) throw new Error("Synthetic AI timeout");
      if (state.demoteOwnerDuringGeneration) state.ownerStatus = "member";
      return `Synthetic generated announcement ${state.generations}`;
    },
  });
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
  const sent: { chatId: number | string; text: string; topicId?: number; buttons: string[] }[] = [];
  const state = {
    chatType: "supergroup",
    targetStatus: "member",
    ownerStatus: "creator",
    banFails: false,
    bans: 0,
    deletions: 0,
    deletionFails: false,
    messagePresent: true,
    targetStatusAfterBan: "member",
    ownerStatusAfterBan: "creator",
    announcementFails: false,
    announcements: 0,
    demoteOwnerAfterBan: false,
    generations: 0,
    generationFails: false,
    demoteOwnerDuringGeneration: false,
  };
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "getChat") {
      return {
        ok: true,
        result: { id: config.allowedChatId, type: state.chatType, title: "Synthetic" },
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
      if (payload.chat_id === config.allowedChatId && state.bans > 0) {
        state.announcements++;
        assert.ok([...cases.values()].some((item) => item.status === "banned"));
        assert.equal("reply_parameters" in payload, false);
        assert.ok("disable_notification" in payload && payload.disable_notification);
        if (state.announcementFails) throw new Error("Synthetic announcement timeout");
      }
      sent.push({
        chatId: payload.chat_id,
        text: payload.text,
        buttons:
          "reply_markup" in payload &&
          payload.reply_markup &&
          "inline_keyboard" in payload.reply_markup
            ? payload.reply_markup.inline_keyboard.flat().map((button) => button.text)
            : [],
        ...("message_thread_id" in payload ? { topicId: payload.message_thread_id } : {}),
      });
      return { ok: true, result: { message_id: 1000 + sent.length } } as never;
    }
    if (method === "banChatMember") {
      state.bans++;
      assert.ok("user_id" in payload);
      assert.ok("chat_id" in payload);
      assert.equal(payload.user_id, 2);
      assert.equal(payload.chat_id, config.allowedChatId);
      assert.equal("until_date" in payload, false);
      assert.ok("revoke_messages" in payload && payload.revoke_messages === true);
      if (state.banFails) throw new Error("Synthetic timeout");
      state.targetStatus = state.targetStatusAfterBan;
      state.ownerStatus = state.ownerStatusAfterBan;
      if (state.demoteOwnerAfterBan) state.ownerStatus = "member";
    }
    if (method === "deleteMessages") {
      state.deletions++;
      assert.ok("chat_id" in payload && "message_ids" in payload);
      assert.equal(payload.chat_id, config.allowedChatId);
      const item = [...cases.values()].find(
        (candidate) => candidate.messageId === payload.message_ids[0],
      );
      assert.ok(item);
      assert.equal(item.status, "banned");
      assert.equal(item.userId, 2n);
      assert.deepEqual(payload.message_ids, [item.messageId]);
      if (state.deletionFails) throw new Error("Synthetic deletion failure");
      state.messagePresent = false;
    }
    if (method === "deleteMessage") assert.fail("Unexpected individual deletion");
    return { ok: true, result: true } as never;
  });
  return { bot, store, cases, sent, state };
}

void test("advertising only sends an owner review; confirmation bans once across duplicate callbacks", async () => {
  const { bot, cases, sent, state } = setup();
  await bot.handleUpdate(message());
  await bot.waitForRequests();
  assert.equal(state.bans, 0);
  assert.equal(state.generations, 0);
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
  assert.equal(state.deletions, 1);
  assert.equal(state.messagePresent, false);
  assert.equal(item.status, "banned");
  assert.equal(item.decidedBy, 1n);
  assert.equal(state.announcements, 1);
  assert.equal(state.generations, 1);
  const announcement = sent.find((entry) => entry.chatId === config.allowedChatId)!;
  assert.equal(announcement.text, "Synthetic generated announcement 1");
  assert.equal(announcement.topicId, undefined);
  assert.ok(!announcement.text.includes(item.authorLabel));
  assert.ok(!announcement.text.includes(item.text));
  assert.ok(!announcement.text.includes(item.reason!));
  assert.ok(sent.some((entry) => entry.chatId === 1 && /забанила навсегда/.test(entry.text)));
  await bot.closeRequests();
});

void test("creative events include prior human conversation and ask the owner without recommending punishment", async () => {
  const history = ["Мне нравится свет на твоём эскизе", "Спасибо за совет, попробую другой ракурс"];
  const { bot, cases, sent, state } = setup(async (evidence) => {
    if (history.includes(evidence.text))
      return { category: "clean", reason: "Живое обсуждение рисунка" };
    assert.deepEqual(evidence.previousMessages, history);
    assert.equal(evidence.observedMessageCount, 3);
    return {
      category: "community_event",
      reason:
        "Творческая встреча. Ранее автор обсуждал рисунки без рекламы; нужен ответ владельца, а не санкции.",
    };
  });
  try {
    for (const [index, text] of [
      ...history,
      "В субботу встреча для скетчинга, регистрация по ссылке",
    ].entries()) {
      await bot.handleUpdate(message(text, 10 + index));
      await bot.waitForRequests();
    }
    assert.equal(state.bans, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, 1);
    assert.match(sent[0]!.text, /анонс творческого события/);
    assert.match(sent[0]!.text, /не основание для бана или удаления/);
    assert.match(sent[0]!.text, /Ранее автор обсуждал рисунки/);
    assert.equal(sent[0]!.buttons[0], "Оставить без санкций");
    const item = [...cases.values()].at(-1)!;
    await bot.handleUpdate(callback(item, "ban", 3));
    assert.equal(item.status, "review");
    assert.equal(state.bans, 0);
    await bot.handleUpdate(callback(item, "keep"));
    assert.equal(item.status, "kept");
    assert.equal(state.bans, 0);
    assert.equal(state.announcements, 0);
  } finally {
    await bot.closeRequests();
  }
});

void test("spam and ambiguous posts have different owner assessments but neither auto-enforces", async () => {
  for (const category of ["spam", "suspicious"] as const) {
    const { bot, cases, sent, state } = setup(async () => ({
      category,
      reason: "Synthetic evidence",
    }));
    try {
      await bot.handleUpdate(message());
      await bot.waitForRequests();
      assert.equal(state.bans, 0);
      assert.equal([...cases.values()][0]!.category, category);
      assert.match(
        sent[0]!.text,
        category === "spam"
          ? /не доказательство, что автор — бот/
          : /Оснований рекомендовать бан или удаление недостаточно/,
      );
      assert.equal(
        sent[0]!.buttons[0],
        category === "spam" ? "Забанить навсегда" : "Оставить без санкций",
      );
    } finally {
      await bot.closeRequests();
    }
  }
});

void test("ban announcements stay in the source topic and vary between confirmed bans", async () => {
  const { bot, cases, sent, state } = setup();
  try {
    for (const updateId of [10, 11]) {
      const update = message("Synthetic promotion", updateId);
      assert.ok(update.message);
      update.message.message_thread_id = 77;
      await bot.handleUpdate(update);
      await bot.waitForRequests();
      const item = [...cases.values()].at(-1)!;
      await bot.handleUpdate(callback(item));
    }
    const announcements = sent.filter((entry) => entry.chatId === config.allowedChatId);
    assert.equal(state.bans, 2);
    assert.equal(announcements.length, 2);
    assert.ok(announcements.every((entry) => entry.topicId === 77));
    assert.notEqual(announcements[0]!.text, announcements[1]!.text);
  } finally {
    await bot.closeRequests();
  }
});

void test("basic groups also explicitly remove the banned user's source message", async () => {
  const { bot, cases, state } = setup();
  state.chatType = "group";
  const update = message();
  assert.ok(update.message);
  update.message.chat = { id: config.allowedChatId!, type: "group", title: "Synthetic" };
  try {
    await bot.handleUpdate(update);
    await bot.waitForRequests();
    await bot.handleUpdate(callback([...cases.values()][0]!));
    assert.equal(state.bans, 1);
    assert.equal(state.deletions, 1);
    assert.equal(state.messagePresent, false);
    assert.equal(state.announcements, 1);
  } finally {
    await bot.closeRequests();
  }
});

void test("cleanup failure preserves the confirmed ban and reports no deletion success", async () => {
  const { bot, cases, sent, state } = setup();
  try {
    await bot.handleUpdate(message());
    await bot.waitForRequests();
    const item = [...cases.values()][0]!;
    state.deletionFails = true;
    state.generationFails = true;
    await bot.handleUpdate(callback(item));
    assert.equal(item.status, "banned");
    assert.equal(state.messagePresent, true);
    assert.match(
      sent.at(-1)!.text,
      /забанила навсегда.*Удаление исходного сообщения подтвердить не удалось/s,
    );
    const announcement = sent.find((entry) => entry.chatId === config.allowedChatId)!;
    assert.doesNotMatch(announcement.text, /удалила|убрала|очистила/);
    await bot.handleUpdate(callback(item));
    assert.equal(state.bans, 1);
    assert.equal(state.deletions, 1);
    assert.equal(state.announcements, 1);
  } finally {
    await bot.closeRequests();
  }
});

void test("cleanup accepts a kicked target and a source already removed by revocation", async () => {
  const { bot, cases, sent, state } = setup();
  try {
    await bot.handleUpdate(message());
    await bot.waitForRequests();
    state.targetStatusAfterBan = "kicked";
    state.messagePresent = false;
    await bot.handleUpdate(callback([...cases.values()][0]!));
    assert.equal(state.deletions, 1);
    assert.match(sent.at(-1)!.text, /исходного сообщения в чате больше нет/);
  } finally {
    await bot.closeRequests();
  }
});

void test("cleanup rechecks protection, delete rights, and Telegram's message age limit", async () => {
  for (const scenario of ["promoted", "owner-demoted", "delete-rights-lost", "old"] as const) {
    const { bot, cases, sent, state } = setup();
    try {
      const update = message();
      assert.ok(update.message);
      if (scenario === "old") update.message.date -= 49 * 60 * 60;
      await bot.handleUpdate(update);
      await bot.waitForRequests();
      if (scenario === "promoted") state.targetStatusAfterBan = "administrator";
      if (scenario === "owner-demoted") state.demoteOwnerAfterBan = true;
      if (scenario === "delete-rights-lost") state.ownerStatusAfterBan = "administrator";
      const item = [...cases.values()][0]!;
      await bot.handleUpdate(callback(item));
      assert.equal(item.status, "banned");
      assert.equal(state.bans, 1);
      assert.equal(state.deletions, 0);
      assert.match(sent.at(-1)!.text, /Удаление исходного сообщения подтвердить не удалось/);
    } finally {
      await bot.closeRequests();
    }
  }
});

void test("an announcement failure or owner demotion preserves the ban and never retries delivery", async () => {
  for (const scenario of ["timeout", "demotion", "demotion-during-generation"] as const) {
    const { bot, cases, sent, state } = setup();
    try {
      await bot.handleUpdate(message());
      await bot.waitForRequests();
      const item = [...cases.values()][0]!;
      state.announcementFails = scenario === "timeout";
      state.demoteOwnerAfterBan = scenario === "demotion";
      state.demoteOwnerDuringGeneration = scenario === "demotion-during-generation";
      await bot.handleUpdate(callback(item));
      assert.equal(item.status, "banned");
      assert.match(
        sent.at(-1)!.text,
        /забанила навсегда.*Не удалось подтвердить отправку объявления/s,
      );
      await bot.handleUpdate(callback(item));
      assert.equal(state.bans, 1);
      assert.equal(state.announcements, scenario === "timeout" ? 1 : 0);
      assert.equal(state.generations, scenario === "demotion" ? 0 : 1);
    } finally {
      await bot.closeRequests();
    }
  }
});

void test("AI failure sends a fallback once without affecting the confirmed ban", async () => {
  const { bot, cases, sent, state } = setup();
  try {
    await bot.handleUpdate(message());
    await bot.waitForRequests();
    const item = [...cases.values()][0]!;
    state.generationFails = true;
    await bot.handleUpdate(callback(item));
    await bot.handleUpdate(callback(item));
    assert.equal(item.status, "banned");
    assert.equal(state.bans, 1);
    assert.equal(state.generations, 1);
    assert.equal(state.announcements, 1);
    assert.match(
      sent.find((entry) => entry.chatId === config.allowedChatId)!.text,
      /Продолжаем разговор/,
    );
  } finally {
    await bot.closeRequests();
  }
});

void test("a failed audit write after Telegram confirms the ban suppresses the announcement", async () => {
  const { bot, store, cases, state } = setup();
  try {
    await bot.handleUpdate(message());
    await bot.waitForRequests();
    const item = [...cases.values()][0]!;
    const transition = store.transition.bind(store);
    store.transition = async (id, from, to, change) => {
      if (to === "banned") throw new Error("Synthetic persistence failure");
      return transition(id, from, to, change);
    };
    await bot.handleUpdate(callback(item));
    await bot.handleUpdate(callback(item));
    assert.equal(item.status, "unknown");
    assert.equal(state.bans, 1);
    assert.equal(state.announcements, 0);
    assert.equal(state.generations, 0);
  } finally {
    await bot.closeRequests();
  }
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
    assert.equal(state.announcements, 0);
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
    assert.equal(state.announcements, 0);
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
  assert.equal(state.deletions, 0);
  assert.equal(state.announcements, 0);
  assert.equal(state.generations, 0);
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
          assert.match(String(request.instructions), /Prior genuine replies/);
          assert.match(String(request.instructions), /Prefer this category over advertising/);
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
  for (const category of ["spam", "community_event"]) {
    assert.equal(
      parseClassification(JSON.stringify({ category, reason: "Synthetic reason" })).category,
      category,
    );
  }
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
    assert.doesNotMatch(sent.at(-1)!.text, /забанила навсегда/);
    await bot.handleUpdate({ update_id: initial.update_id + 1, edited_message: edit });
    assert.equal(cases.size, 2);
  } finally {
    await bot.closeRequests();
  }
});
