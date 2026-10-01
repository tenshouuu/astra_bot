import type { AppConfig } from "@app/config/env";
import type { Context } from "grammy";

function matchesUsername(actual: string | undefined, configured: string): boolean {
  return (
    actual !== undefined &&
    actual.toLowerCase() === configured.trim().replace(/^@/, "").toLowerCase()
  );
}

export function isMemoryChat(ctx: Context, config: AppConfig): boolean {
  const chat = ctx.chat;
  if (!chat) return false;
  if (chat.type === "private") return matchesUsername(ctx.from?.username, config.ownerUsername);
  if (chat.type !== "group" && chat.type !== "supergroup") return false;
  if (config.allowedChatId !== undefined) return chat.id === config.allowedChatId;
  return (
    chat.type === "supergroup" &&
    config.allowedChatUsername !== undefined &&
    matchesUsername(chat.username, config.allowedChatUsername)
  );
}

export async function canAsk(ctx: Context, config: AppConfig): Promise<boolean> {
  if (!ctx.from || ctx.from.is_bot || ctx.message?.sender_chat || !isMemoryChat(ctx, config))
    return false;

  if (ctx.chat?.type === "private") return true;

  if (!ctx.chat) return false;
  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  return member.status === "creator" || member.status === "administrator";
}
