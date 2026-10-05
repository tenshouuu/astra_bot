import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, Context } from "grammy";
import type { UserFromGetMe, Update } from "grammy/types";
import type { AppConfig } from "@app/config/env";
import { createTelegramTools } from "@app/modules/telegram/tools";
import { createAskHandler } from "@app/modules/telegram/ask";
import {
  createModerationActions,
  createModerationCallback,
} from "@app/modules/telegram/moderation";
import { createModeration } from "@app/modules/moderation/service";
import { createAsk, type ResponsesClient } from "@app/modules/openai/api";
import { fakeModerationStore } from "./helpers/moderation";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "silent",
  botToken: "synthetic-token",
  databaseUrl: "postgresql://localhost/synthetic",
  openaiApiKey: "synthetic-key",
  openaiModel: "test-model",
  ownerUsername: "owner",
  ownerUserId: 1,
  allowedChatId: -1001234567890,
  moderationEnabled: true,
  protectedUserIds: [9],
};
const me: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: "Astra",
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

async function setup(role = "administrator") {
  const { store, cases } = fakeModerationStore();
  await store.observe({
    updateId: 1,
    chatId: BigInt(config.allowedChatId!),
    userId: 3n,
    messageId: 10,
    topicId: 7,
    text: "Synthetic ad",
    replyText: "",
    authorLabel: "Synthetic member",
    isBot: false,
    sentAt: new Date(),
  });
  const source = [...cases.values()][0]!;
  await store.transition(source.id, "queued", "clean");
  const roles = new Map([
    [1, "creator"],
    [2, role],
    [3, "member"],
  ]);
  const sent: { chatId: number | string; text: string; buttons: unknown }[] = [];
  const state = {
    bans: 0,
    deletes: 0,
    deletionFails: false,
    revokeDuringCheck: false,
    profileLookups: 0,
  };
  const api = new Api(config.botToken);
  api.config.use(async (_previous, method, payload) => {
    if (method === "getChat")
      return {
        ok: true,
        result: { id: config.allowedChatId, type: "supergroup", title: "Synthetic group" },
      } as never;
    if (method === "getChatMember" && "user_id" in payload) {
      if (payload.user_id === 3) state.profileLookups++;
      if (payload.user_id === 3 && state.revokeDuringCheck) roles.set(2, "member");
      return {
        ok: true,
        result: {
          status: roles.get(payload.user_id) ?? "member",
          can_restrict_members: true,
          can_delete_messages: true,
          user: { id: payload.user_id, is_bot: false, first_name: "Synthetic" },
        },
      } as never;
    }
    if (method === "getChatMemberCount") return { ok: true, result: 23 } as never;
    if (method === "sendMessage" && "chat_id" in payload && "text" in payload) {
      sent.push({
        chatId: payload.chat_id,
        text: payload.text,
        buttons: "reply_markup" in payload ? payload.reply_markup : undefined,
      });
      return { ok: true, result: { message_id: 500 + sent.length } } as never;
    }
    if (method === "banChatMember") state.bans++;
    if (method === "deleteMessage") {
      assert.ok("chat_id" in payload && "message_id" in payload);
      assert.equal(payload.chat_id, config.allowedChatId);
      assert.equal(payload.message_id, 10);
      state.deletes++;
      if (state.deletionFails) throw new Error("Synthetic timeout");
    }
    return { ok: true, result: true } as never;
  });
  const moderation = createModeration(
    store,
    async () => ({ category: "clean", reason: "Synthetic" }),
    createModerationActions(config, api),
    1,
  );
  const update: Update = {
    update_id: 20,
    message: {
      message_id: 20,
      date: Math.floor(Date.now() / 1000),
      chat: { id: config.allowedChatId!, type: "supergroup", title: "Synthetic" },
      from: { id: 2, is_bot: false, first_name: "Synthetic actor" },
      message_thread_id: 7,
      text: "/ask Synthetic",
    },
  };
  const ctx = new Context(update, api, me);
  return { store, cases, source, roles, state, sent, api, moderation, ctx };
}

void test("members see read-only capabilities and cannot request moderation through forged function arguments", async () => {
  const { ctx, store, moderation, sent, state } = await setup("member");
  const runtime = await createTelegramTools(ctx, config, store, moderation);
  assert.deepEqual(
    runtime.tools.map((tool) => tool.name),
    ["get_chat_info", "get_chat_member_count", "get_my_profile", "search_my_messages"],
  );
  assert.deepEqual(
    await runtime.execute("request_moderation_review", {
      message_id: 10,
      action: "ban",
      reason: "Synthetic",
    }),
    { error: "tool_unavailable" },
  );
  assert.deepEqual(await runtime.execute("get_chat_info", { chat_id: -200 }), {
    error: "invalid_arguments",
  });
  assert.equal(state.bans, 0);
  assert.equal(sent.length, 0);
  await moderation.close();
});

void test("members have common and self tools; forged targets cannot inspect others", async () => {
  const { ctx, store, moderation, state } = await setup("member");
  try {
    await store.observe({
      updateId: 2,
      chatId: BigInt(config.allowedChatId!),
      userId: 2n,
      messageId: 11,
      topicId: 7,
      text: "My synthetic message",
      replyText: "",
      authorLabel: "Self",
      isBot: false,
      sentAt: new Date(),
    });
    const runtime = await createTelegramTools(ctx, config, store, moderation);
    assert.equal(runtime.requestContext.actor_role, "member");
    assert.equal(runtime.requestContext.may_inspect_other_members, false);
    assert.deepEqual(await runtime.execute("get_chat_member_count", {}), {
      chat_id: config.allowedChatId,
      member_count: 23,
    });
    const profile = (await runtime.execute("get_my_profile", {})) as { user_id: number };
    assert.equal(profile.user_id, 2);
    const search = (await runtime.execute("search_my_messages", { query: "" })) as {
      messages: { user_id: number; message_id: number }[];
      user_id_filter: number;
    };
    assert.equal(search.user_id_filter, 2);
    assert.deepEqual(
      search.messages.map((item) => [item.user_id, item.message_id]),
      [[2, 11]],
    );
    assert.deepEqual(await runtime.execute("get_my_profile", { user_id: 3 }), {
      error: "invalid_arguments",
    });
    assert.deepEqual(await runtime.execute("search_my_messages", { query: "", user_id: 3 }), {
      error: "invalid_arguments",
    });
    assert.deepEqual(await runtime.execute("get_member_info", { user_id: 3 }), {
      error: "tool_unavailable",
    });
    assert.deepEqual(await runtime.execute("search_messages", { query: "", user_id: null }), {
      error: "tool_unavailable",
    });
    assert.equal(state.profileLookups, 0);
  } finally {
    await moderation.close();
  }
});

void test("admin inspection works independently of moderation and is revoked before returning or sending data", async () => {
  for (const scenario of ["before", "during-profile", "during-search", "after"] as const) {
    const { ctx, store, moderation, roles, state } = await setup();
    try {
      const runtime = await createTelegramTools(
        ctx,
        { ...config, moderationEnabled: false },
        store,
      );
      assert.equal(runtime.requestContext.may_inspect_other_members, true);
      assert.equal(runtime.requestContext.may_request_moderation_review, false);
      assert.ok(runtime.tools.some((tool) => tool.name === "get_member_info"));
      if (scenario === "before") roles.set(2, "member");
      if (scenario === "during-profile") state.revokeDuringCheck = true;
      if (scenario === "during-search") {
        store.search = async () => {
          roles.set(2, "member");
          return [{ messageId: 10, userId: 3n, text: "Restricted data", sentAt: new Date() }];
        };
      }
      const result =
        scenario === "during-search"
          ? await runtime.execute("search_messages", { query: "", user_id: 3 })
          : await runtime.execute("get_member_info", { user_id: 3 });
      if (scenario === "after") {
        assert.equal((result as { user_id: number }).user_id, 3);
        assert.equal(await runtime.authorizeResponse!(), true);
        roles.set(2, "member");
        assert.equal(await runtime.authorizeResponse!(), false);
      } else assert.deepEqual(result, { error: "access_denied" });
      if (scenario === "before") assert.equal(state.profileLookups, 0);
    } finally {
      await moderation.close();
    }
  }
});

void test("search and review sources are scoped to the current group/topic and member status comes from Telegram", async () => {
  const { ctx, store, moderation, sent } = await setup();
  await store.observe({
    updateId: 2,
    chatId: BigInt(config.allowedChatId!),
    userId: 3n,
    messageId: 11,
    topicId: 8,
    text: "Other topic",
    replyText: "",
    authorLabel: "Synthetic",
    isBot: false,
    sentAt: new Date(),
  });
  const runtime = await createTelegramTools(ctx, config, store, moderation);
  const result = (await runtime.execute("search_messages", { query: "", user_id: null })) as {
    messages: { message_id: number }[];
  };
  assert.deepEqual(
    result.messages.map((message) => message.message_id),
    [10],
  );
  assert.deepEqual(
    await runtime.execute("request_moderation_review", {
      message_id: 11,
      action: "ban",
      reason: "Synthetic",
    }),
    { error: "source_unavailable", action_executed: false },
  );
  const member = (await runtime.execute("get_member_info", { user_id: 3 })) as {
    user_id: number;
    status: string;
    account_creation_date: unknown;
  };
  assert.equal(member.user_id, 3);
  assert.equal(member.status, "member");
  assert.equal(member.account_creation_date, null);
  assert.equal(sent.length, 0);
  await moderation.close();
});

void test("admin data is not delivered after demotion while composing an answer or between chunks", async () => {
  for (const betweenChunks of [false, true]) {
    const { ctx, api, store, moderation, roles, sent } = await setup();
    const handler = createAskHandler(
      config,
      async (_question, _history, runtime) => {
        const result = (await runtime!.execute("get_member_info", { user_id: 3 })) as {
          user_id: number;
        };
        assert.equal(result.user_id, 3);
        if (!betweenChunks) roles.set(2, "member");
        return "a".repeat(7001);
      },
      undefined,
      (request) => createTelegramTools(request, config, store, moderation),
    );
    api.config.use(async (previous, method, payload, signal) => {
      const result = await previous(method, payload, signal);
      if (betweenChunks && method === "sendMessage") roles.set(2, "member");
      return result;
    });
    try {
      assert.ok(ctx.has("message:text"));
      ctx.message.text = "@synthetic_bot проверь участника";
      await handler.addressed(ctx);
      await handler.waitForRequests();
      assert.deepEqual(
        sent.map((message) => message.text),
        betweenChunks ? ["a".repeat(3500)] : [],
      );
    } finally {
      await handler.close();
      await moderation.close();
    }
  }
});

void test("revoking administrator status before or during a tool request prevents notifications and actions", async () => {
  for (const during of [false, true]) {
    const { ctx, store, moderation, roles, state, sent } = await setup();
    const runtime = await createTelegramTools(ctx, config, store, moderation);
    if (during) state.revokeDuringCheck = true;
    else roles.set(2, "member");
    await runtime.execute("request_moderation_review", {
      message_id: 10,
      action: "delete",
      reason: "Synthetic",
    });
    assert.equal(sent.length, 0);
    assert.equal(state.bans + state.deletes, 0);
    await moderation.close();
  }
});

void test("function-calling search to deletion review sends only a private request, then owner confirmation deletes once", async () => {
  const { ctx, store, moderation, source, sent, state, api } = await setup();
  const runtime = await createTelegramTools(ctx, config, store, moderation);
  let requests = 0;
  const client = {
    responses: {
      create: async (request: { input: { output?: string }[] }) => {
        requests++;
        if (requests === 1)
          return {
            status: "completed",
            output_text: "",
            output: [
              {
                type: "function_call",
                call_id: "search",
                name: "search_messages",
                arguments: '{"query":"ad","user_id":null}',
              },
            ],
          };
        if (requests === 2) {
          assert.equal(JSON.parse(request.input.at(-1)!.output!).messages[0].message_id, 10);
          return {
            status: "completed",
            output_text: "",
            output: [
              {
                type: "function_call",
                call_id: "review",
                name: "request_moderation_review",
                arguments: '{"message_id":10,"action":"delete","reason":"Рекламное объявление"}',
              },
            ],
          };
        }
        assert.equal(
          JSON.parse(request.input.at(-1)!.output!).status,
          "pending_owner_confirmation",
        );
        return {
          status: "completed",
          output_text: "Заявка отправлена владельцу в ЛС; сообщение пока не удалено.",
          output: [],
        };
      },
    },
  } as unknown as ResponsesClient;
  assert.match(
    await createAsk(config, client)("Найди объявление и попроси удалить", [], runtime),
    /пока не удалено/,
  );
  assert.equal(state.bans + state.deletes, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, 1);
  assert.match(sent[0]?.text ?? "", /Запрос администратора \(ID 2\)/);
  assert.equal(source.action, "delete");
  assert.equal(source.requestedBy, 2n);
  assert.match(
    await moderation.decide(source.id, 1, source.notificationMessageId!, "ban"),
    /не соответствует/,
  );
  const callback: Update = {
    update_id: 100,
    callback_query: {
      id: "synthetic",
      from: { id: 1, is_bot: false, first_name: "Owner" },
      chat_instance: "synthetic",
      data: `mod:delete:${source.id}`,
      message: {
        message_id: source.notificationMessageId!,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "private", first_name: "Owner" },
        text: "Synthetic review",
      },
    },
  };
  const handler = createModerationCallback(config, moderation);
  await handler(new Context(callback, api, me));
  await handler(new Context(callback, api, me));
  assert.equal(state.deletes, 1);
  assert.equal(state.bans, 0);
  assert.equal(source.status, "deleted");
  assert.ok(sent.every((message) => message.chatId === 1));
  await moderation.close();
});

void test("duplicate manual review requests, protected targets and ambiguous deletion never repeat side effects", async () => {
  const { ctx, store, moderation, source, sent, state, roles } = await setup();
  const runtime = await createTelegramTools(ctx, config, store, moderation);
  roles.set(3, "administrator");
  await runtime.execute("request_moderation_review", {
    message_id: 10,
    action: "ban",
    reason: "Synthetic",
  });
  assert.equal(sent.length, 0);
  roles.set(3, "member");
  const args = { message_id: 10, action: "delete", reason: "Synthetic" };
  await Promise.all([
    runtime.execute("request_moderation_review", args),
    runtime.execute("request_moderation_review", args),
  ]);
  assert.equal(sent.length, 1);
  state.deletionFails = true;
  await moderation.decide(source.id, 1, source.notificationMessageId!, "delete");
  await moderation.decide(source.id, 1, source.notificationMessageId!, "delete");
  assert.equal(state.deletes, 1);
  assert.equal(source.status, "unknown");
  await moderation.close();
});

void test("assistant receives actual background monitoring state and search reports partial history scope", async () => {
  const { ctx, store, moderation } = await setup();
  try {
    const runtime = await createTelegramTools(ctx, config, store, moderation);
    assert.equal(runtime.requestContext.automatic_moderation_enabled, true);
    const info = (await runtime.execute("get_chat_info", {})) as Record<string, unknown>;
    assert.equal(info.monitoring_mode, "background_owner_review");
    assert.equal(info.full_telegram_history_available, false);
    const search = (await runtime.execute("search_messages", {
      query: "not found",
      user_id: null,
    })) as Record<string, unknown>;
    assert.deepEqual(search.messages, []);
    assert.equal(search.exhaustive, false);
    assert.equal(search.topic_id, 7);
    assert.equal(search.result_limit, 3);
    const disabled = await createTelegramTools(ctx, { ...config, moderationEnabled: false }, store);
    assert.equal(disabled.requestContext.automatic_moderation_enabled, false);
    const disabledInfo = (await disabled.execute("get_chat_info", {})) as Record<string, unknown>;
    assert.equal(disabledInfo.monitoring_mode, "disabled");
  } finally {
    await moderation.close();
  }
});

void test("edits during Telegram eligibility prevent both bans and deletions", async () => {
  for (const action of ["ban", "delete"] as const) {
    const { ctx, store, moderation, state } = await setup();
    try {
      const item = await store.source(BigInt(config.allowedChatId!), 7, 10);
      assert.ok(item);
      item.action = action;

      ctx.api.config.use(async (previous, method, payload, signal) => {
        const result = await previous(method, payload, signal);
        if (method === "getChatMember" && "user_id" in payload && payload.user_id === 3)
          await store.observe({ ...item, updateId: item.updateId + 100, text: "" });
        return result;
      });
      const actions = createModerationActions(config, ctx.api);
      const outcome =
        action === "ban"
          ? await actions.ban(item, () => store.isCurrent(item))
          : await actions.deleteMessage!(item, () => store.isCurrent(item));
      assert.equal(outcome, "denied");
      assert.equal(state.bans, 0);
      assert.equal(state.deletes, 0);
    } finally {
      await moderation.close();
    }
  }
});
