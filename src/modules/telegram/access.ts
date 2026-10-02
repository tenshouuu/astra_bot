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
  if (chat.type === "private") {
    return config.ownerUserId !== undefined
      ? ctx.from?.id === config.ownerUserId
      : matchesUsername(ctx.from?.username, config.ownerUsername);
  }
  if (chat.type !== "group" && chat.type !== "supergroup") return false;
  return isAllowedGroup(chat, config);
}

export function configuredChatIds(config: AppConfig): readonly number[] {
  return config.allowedChatIds?.length
    ? config.allowedChatIds
    : config.allowedChatId === undefined
      ? []
      : [config.allowedChatId];
}

export function isAllowedGroup(
  chat: { id: number; type: string; username?: string | undefined },
  config: AppConfig,
): boolean {
  if (chat.type !== "group" && chat.type !== "supergroup") return false;
  const ids = configuredChatIds(config);
  if (ids.length) return ids.includes(chat.id);
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
  if (member.user.id !== ctx.from.id) return false;
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member" ||
    (member.status === "restricted" && member.is_member)
  );
}

export async function canManageChat(ctx: Context, config: AppConfig): Promise<boolean> {
  if (!ctx.from || ctx.from.is_bot || ctx.message?.sender_chat || !isMemoryChat(ctx, config))
    return false;
  if (ctx.chat?.type === "private") return true;
  if (!ctx.chat) return false;
  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  if (member.user.id !== ctx.from.id) return false;
  return member.status === "creator" || member.status === "administrator";
}
