import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, Context } from "grammy";
import type { AppConfig } from "@app/config/env";
import { getConfig } from "@app/config/env";
import { canAsk, canManageChat, isAllowedGroup } from "@app/modules/telegram/access";
import { createTelegramTools } from "@app/modules/telegram/tools";
import { fakeModerationStore } from "./helpers/moderation";
import { createModerationActions } from "@app/modules/telegram/moderation";

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
  allowedChatIds: [-100, -200],
  allowedChatUsername: "synthetic_group",
  moderationEnabled: true,
};

void test("ALLOWED_CHAT_ID parses one or several IDs and rejects malformed lists", () => {
  const entries = {
    TELEGRAM_BOT_TOKEN: "synthetic-token",
    DATABASE_URL: "postgresql://localhost/synthetic",
    OPENAI_API_KEY: "synthetic-key",
    OWNER_USERNAME: "owner",
    MODERATION_ENABLED: "false",
    OWNER_USER_ID: "1",
    PROTECTED_USER_IDS: "",
    ALLOWED_CHAT_USERNAME: "",
    ALLOWED_CHAT_ID: "",
  };
  const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, entries);
    process.env.ALLOWED_CHAT_ID = "-100, -200, -100";
    assert.deepEqual(getConfig().allowedChatIds, [-100, -200]);
    assert.equal(getConfig().allowedChatId, undefined);
    assert.equal(getConfig().ownerUserId, undefined);
    process.env.ALLOWED_CHAT_ID = "-100";
    assert.equal(getConfig().allowedChatId, -100);
    assert.deepEqual(getConfig().allowedChatIds, [-100]);
    for (const invalid of [
      "-100,",
      ",-100",
      "-100,, -200",
      "-100,0",
      "-100,1",
      "-1.5",
      "-9007199254740992",
      "abc",
    ]) {
      process.env.ALLOWED_CHAT_ID = invalid;
      assert.throws(getConfig, /ALLOWED_CHAT_ID/);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function context(chatId: number, privateChat = false) {
  const api = new Api("synthetic-token");
  const calls: number[] = [];
  api.config.use(async (_previous, method, payload) => {
    if (method === "getChat") {
      const id = Number((payload as { chat_id: number }).chat_id);
      calls.push(id);
      return { ok: true, result: { id, type: "supergroup", title: "Synthetic" } } as never;
    }
    if (method === "getChatMember") {
      const id = Number((payload as { user_id: number }).user_id);
      return {
        ok: true,
        result: {
          status: "administrator",
          can_restrict_members: true,
          can_delete_messages: true,
          user: { id, is_bot: false, first_name: "Synthetic" },
        },
      } as never;
    }
    assert.fail(`Unexpected API method ${method}`);
  });
  const ctx = new Context(
    {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: "Synthetic question",
        from: { id: 1, is_bot: false, first_name: "Owner" },
        chat: privateChat
          ? { id: 1, type: "private", first_name: "Owner" }
          : { id: chatId, type: "supergroup", title: "Synthetic" },
      },
    },
    api,
    { id: 42, is_bot: true, first_name: "Astra" } as Context["me"],
  );
  return { ctx, calls };
}

void test("access and management accept both configured groups and reject others despite matching usernames", async () => {
  for (const id of [-100, -200, -300]) {
    const { ctx } = context(id);
    assert.equal(await canAsk(ctx, config), id !== -300);
    assert.equal(await canManageChat(ctx, config), id !== -300);
    assert.equal(
      isAllowedGroup({ id, type: "supergroup", username: "synthetic_group" }, config),
      id !== -300,
    );
  }
});

void test("tools remain in the current group and private tools require an allowed explicit chat selection", async () => {
  const group = context(-200);
  const runtime = await createTelegramTools(group.ctx, config);
  const result = await runtime.execute("get_chat_info", {});
  assert.equal((result as { chat_id: number }).chat_id, -200);
  assert.deepEqual(await runtime.execute("get_chat_info", { chat_id: -100 }), {
    error: "invalid_arguments",
  });
  assert.deepEqual(group.calls, [-200]);

  const owner = context(1, true);
  const { store } = fakeModerationStore();
  const searches: bigint[] = [];
  store.search = async (chatId) => {
    searches.push(chatId);
    return [];
  };
  const privateRuntime = await createTelegramTools(owner.ctx, config, store);
  assert.deepEqual(privateRuntime.requestContext.available_chat_ids, [-100, -200]);
  assert.deepEqual(privateRuntime.tools[0]?.parameters.required, ["chat_id"]);
  assert.deepEqual(await privateRuntime.execute("get_chat_info", {}), {
    error: "invalid_arguments",
  });
  assert.deepEqual(await privateRuntime.execute("get_chat_info", { chat_id: -300 }), {
    error: "invalid_chat_selection",
  });
  const selected = await privateRuntime.execute("get_chat_info", { chat_id: -200 });
  assert.equal((selected as { chat_id: number }).chat_id, -200);
  await privateRuntime.execute("search_messages", { chat_id: -100, query: "", user_id: null });
  await privateRuntime.execute("search_messages", { chat_id: -200, query: "", user_id: null });
  assert.deepEqual(searches, [-100n, -200n]);
  assert.deepEqual(owner.calls, [-200, -100, -200]);
});

void test("moderation validates the case chat and rejects a substituted Telegram chat", async () => {
  const { ctx } = context(-200);
  const actions = createModerationActions(config, ctx.api);
  const source = { chatId: -200n, userId: 3n, sentAt: new Date() } as Parameters<
    typeof actions.eligibility
  >[0];
  // The mock reports every target as an administrator, so it must remain protected in either group.
  assert.equal(await actions.eligibility(source), "protected");
  assert.equal(await actions.eligibility({ ...source, chatId: -100n }), "protected");
  assert.equal(await actions.eligibility({ ...source, chatId: -300n }), "denied");
  const mismatched = createModerationActions(config, {
    getChat: async () => ({ id: -100, type: "supergroup", title: "Synthetic" }) as never,
    getChatMember: async () => assert.fail("No member query after scope mismatch"),
    sendMessage: async () => assert.fail("No notification"),
    banChatMember: async () => assert.fail("No ban"),
    deleteMessage: async () => assert.fail("No deletion"),
  });
  assert.equal(await mismatched.eligibility(source), "denied");
});
