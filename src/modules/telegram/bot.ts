import type { AppConfig } from "@app/config/env";
import type { Ask } from "@app/modules/openai/api";
import type { ConversationMemory } from "@app/modules/memory/service";
import { captureMessages } from "@app/modules/telegram/memory";
import { createAskHandler, createResetHandler } from "@app/modules/telegram/ask";
import { Bot } from "grammy";

export function createBot(config: AppConfig, ask: Ask, memory?: ConversationMemory) {
  const bot = new Bot(config.botToken);

  if (memory) bot.use(captureMessages(config, memory));

  bot.command("ping", async (ctx) => {
    await ctx.reply("Я тут, слушаю.");
  });

  const askHandler = createAskHandler(config, ask, memory);
  bot.command("ask", askHandler);

  if (memory) bot.command("reset", createResetHandler(config, memory, askHandler.isPending));

  bot.catch(({ ctx }) => {
    console.error("Telegram update failed", { updateId: ctx.update.update_id });
  });
  return Object.assign(bot, {
    waitForRequests: askHandler.waitForRequests,
    closeRequests: askHandler.close,
  });
}
