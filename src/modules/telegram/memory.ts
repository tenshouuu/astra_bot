import type { AppConfig } from "@app/config/env";
import type { ConversationMemory } from "@app/modules/memory/service";
import { isMemoryChat } from "@app/modules/telegram/access";
import type { Context, MiddlewareFn } from "grammy";

export function conversationId(ctx: Context): string {
  if (!ctx.chat) throw new Error("Missing Telegram chat");
  return `${ctx.chat.id}:${ctx.msg?.message_thread_id ?? 0}`;
}

export function messageId(ctx: Context): string {
  if (!ctx.chat || !ctx.msg) throw new Error("Missing Telegram message");
  return `${ctx.chat.id}:${ctx.msg.message_id}`;
}

export function messageAuthor(ctx: Context): string {
  if (ctx.from && !ctx.message?.sender_chat) {
    return JSON.stringify({
      id: ctx.from.id,
      username: ctx.from.username,
      name: ctx.from.first_name,
    });
  }
  return JSON.stringify({
    chat_id: ctx.message?.sender_chat?.id,
    name: ctx.message?.sender_chat?.title,
  });
}

export function captureMessages(
  config: AppConfig,
  memory: ConversationMemory,
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const message = ctx.message;
    if (
      !message?.text ||
      !isMemoryChat(ctx, config) ||
      (ctx.from?.is_bot && !message.sender_chat)
    ) {
      await next();
      return;
    }
    // Commands are handled explicitly; ordinary text contributes group/private context.
    const command = message.entities?.find(
      (entity) => entity.offset === 0 && entity.type === "bot_command",
    );
    if (command) {
      await next();
      return;
    }
    await memory.record({
      conversationId: conversationId(ctx),
      externalId: messageId(ctx),
      role: "user",
      author: messageAuthor(ctx),
      text: message.text,
      sentAt: new Date(message.date * 1000),
    });
    memory.refresh(conversationId(ctx));
    await next();
  };
}
