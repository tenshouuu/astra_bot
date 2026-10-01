import { getConfig } from '@app/config/env';
import { Bot } from "grammy";

const config = getConfig();
export const bot = new Bot(getConfig().botToken);

bot.command("ping", async (ctx) => {
  console.log("Получен /ping", {
    chatId: ctx.chat.id,
    chatType: ctx.chat.type,
    chatName: ctx.chat.username,
    userId: ctx.from?.id,
    userName: ctx.from?.username,
    allowedChatId: config.allowedChatId,
    ownerUserId: config.ownerUserId,
  });

  await ctx.reply("pong");
});

bot.catch(({ ctx }) => {
  console.error("TELEGRAM BOT: Error Telegram update", {
    updateId: ctx.update.update_id,
  });
});
