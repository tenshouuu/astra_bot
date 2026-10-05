import type { AppConfig } from "@app/config/env";
import type { Ask } from "@app/modules/openai/api";
import type { ConversationMemory } from "@app/modules/memory/service";
import { captureMessages } from "@app/modules/telegram/memory";
import { createAskHandler, createResetHandler } from "@app/modules/telegram/ask";
import type { Classify, ModerationStore } from "@app/modules/moderation/types";
import { createModeration } from "@app/modules/moderation/service";
import {
  createModerationActions,
  createModerationCallback,
  moderationMiddleware,
} from "@app/modules/telegram/moderation";
import { Bot } from "grammy";
import { resolveOwnerId } from "@app/modules/telegram/owner";
import { addressedQuestion } from "@app/modules/telegram/address";
import { createTelegramTools } from "@app/modules/telegram/tools";

export function createBot(
  config: AppConfig,
  ask: Ask,
  memory?: ConversationMemory,
  review?: {
    store: ModerationStore;
    classify: Classify;
    generateBanAnnouncement?: () => Promise<string>;
  },
) {
  const botConfig = { ...config };
  const bot = new Bot(botConfig.botToken, { client: { timeoutSeconds: 15 } });
  if (botConfig.moderationEnabled && !review) {
    throw new Error("Moderation requires a store and classifier");
  }
  const moderation =
    botConfig.moderationEnabled && review
      ? createModeration(
          review.store,
          review.classify,
          createModerationActions(botConfig, bot.api, review.generateBanAnnouncement),
          () => botConfig.ownerUserId,
        )
      : undefined;

  bot.use(async (ctx, next) => {
    if (ctx.has("message:text") && ctx.message.text.includes("@")) {
      console.info("Telegram mention message received", {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        updateId: ctx.update.update_id,
        botUsername: ctx.me.username,
        addressedToBot: addressedQuestion(ctx) !== undefined,
      });
    }
    await next();
  });

  bot.on("my_chat_member", (ctx) => {
    const change = ctx.update.my_chat_member;
    if (change.chat.type !== "group" && change.chat.type !== "supergroup") return;
    console.info("Telegram bot chat membership changed", {
      chatId: change.chat.id,
      chatType: change.chat.type,
      oldStatus: change.old_chat_member.status,
      newStatus: change.new_chat_member.status,
    });
  });

  bot.command("chatid", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;
    console.info("Telegram chat ID requested", { chatId: ctx.chat.id });
    await ctx.reply(`ID этого чата: ${ctx.chat.id}`);
  });

  if (moderation) {
    bot.use(moderationMiddleware(botConfig, moderation));
    bot.callbackQuery(/^mod:/, createModerationCallback(botConfig, moderation));
    bot.command("start", async (ctx) => {
      if (ctx.chat.type !== "private" || ctx.from?.id !== botConfig.ownerUserId) return;
      await ctx.reply(
        "Буду присылать сюда подозрительные сообщения. Бан — только по твоей кнопке.",
      );
    });
  }

  if (memory) bot.use(captureMessages(botConfig, memory));

  bot.command("ping", async (ctx) => {
    await ctx.reply("Я тут, слушаю.");
  });

  const askHandler = createAskHandler(botConfig, ask, memory, (ctx) =>
    createTelegramTools(ctx, botConfig, review?.store, moderation),
  );
  bot.command("ask", askHandler);

  if (memory) bot.command("reset", createResetHandler(botConfig, memory, askHandler.isPending));
  bot.on("message:text", askHandler.addressed);

  bot.catch(({ ctx }) => {
    console.error("Telegram update failed", { updateId: ctx.update.update_id });
  });
  return Object.assign(bot, {
    waitForRequests: async () => {
      await Promise.all([askHandler.waitForRequests(), moderation?.wait()]);
    },
    closeRequests: async () => {
      await Promise.all([askHandler.close(), moderation?.close()]);
    },
    startModeration: async () => {
      if (!moderation) return;
      try {
        botConfig.ownerUserId = await resolveOwnerId(botConfig, bot.api);
      } catch {
        console.error(
          "Owner resolution failed: verify OWNER_USERNAME and allowed group administrators",
        );
        throw new Error("Owner resolution failed");
      }
      await moderation.start();
      console.info("Moderation monitoring started", {
        enabled: true,
        ownerUserId: botConfig.ownerUserId,
      });
    },
    pruneModeration: async () => moderation?.prune(),
  });
}
