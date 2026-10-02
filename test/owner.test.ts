import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "@app/config/env";
import { resolveOwnerId } from "@app/modules/telegram/owner";
import { createBot } from "@app/modules/telegram/bot";
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
  ownerUsername: "@Synthetic_Owner",
  allowedChatIds: [-100, -200],
  moderationEnabled: true,
};

void test("owner resolves from trusted administrators across allowed groups and public username fallback", async () => {
  const chats: (number | string)[] = [];
  const api = {
    getChatAdministrators: async (chat: number | string) => {
      chats.push(chat);
      return [
        {
          status: "creator",
          user: { id: 1, is_bot: false, first_name: "Synthetic", username: "synthetic_owner" },
        },
      ] as never;
    },
  };
  assert.equal(await resolveOwnerId(config, api), 1);
  assert.deepEqual(chats, [-100, -200]);
  await resolveOwnerId(
    { ...config, allowedChatIds: [], allowedChatUsername: "@synthetic_group" },
    api,
  );
  assert.equal(chats.at(-1), "@synthetic_group");
});

void test("owner resolution rejects missing, bot, conflicting and failed Telegram identities", async () => {
  for (const members of [
    [],
    [{ user: { id: 1, is_bot: true, username: "synthetic_owner" } }],
    [{ user: { id: 1, is_bot: false, username: "wrong_owner" } }],
  ]) {
    await assert.rejects(
      resolveOwnerId(config, { getChatAdministrators: async () => members as never }),
    );
  }
  await assert.rejects(
    resolveOwnerId(config, {
      getChatAdministrators: async (chat) =>
        [
          { user: { id: chat === -100 ? 1 : 2, is_bot: false, username: "synthetic_owner" } },
        ] as never,
    }),
  );
  await assert.rejects(
    resolveOwnerId(config, {
      getChatAdministrators: async () => {
        throw new Error("Synthetic API failure");
      },
    }),
  );
});

void test("username-only moderation startup pins owner ID for private access and never trusts a later username claim", async () => {
  const { store } = fakeModerationStore();
  const bot = createBot(config, async () => "Synthetic answer", undefined, {
    store,
    classify: async () => ({ category: "clean", reason: "Synthetic" }),
  });
  bot.botInfo = { id: 42, is_bot: true, first_name: "Astra", username: "synthetic_bot" } as never;
  const recipients: (number | string)[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "getChatAdministrators")
      return {
        ok: true,
        result: [
          {
            status: "creator",
            user: { id: 1, is_bot: false, first_name: "Owner", username: "synthetic_owner" },
          },
        ],
      } as never;
    if (method === "sendMessage" && "chat_id" in payload) {
      recipients.push(payload.chat_id);
      return { ok: true, result: { message_id: 100 } } as never;
    }
    assert.fail(`Unexpected API method ${method}`);
  });
  await bot.startModeration();
  try {
    for (const id of [1, 2]) {
      await bot.handleUpdate({
        update_id: id,
        message: {
          message_id: id,
          date: 1,
          text: "/start",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
          chat: { id, type: "private", first_name: "Synthetic" },
          from: {
            id,
            is_bot: false,
            first_name: "Synthetic",
            username: id === 1 ? "changed_owner" : "synthetic_owner",
          },
        },
      });
    }
    assert.deepEqual(recipients, [1]);
    assert.equal(config.ownerUserId, undefined);
  } finally {
    await bot.closeRequests();
  }
});
