import type { AppConfig } from "@app/config/env";
import type { ModerationActions, Moderation } from "@app/modules/moderation/service";
import type { ReviewCase } from "@app/modules/moderation/types";
import { isAllowedGroup, isMemoryChat } from "@app/modules/telegram/access";
import type { Api, Context, MiddlewareFn } from "grammy";

type ModerationApi = Pick<
  Api,
  "getChat" | "getChatMember" | "sendMessage" | "banChatMember" | "deleteMessage"
>;

function excerpt(text: string, limit: number): string {
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : text;
}

export function reviewText(item: ReviewCase): string {
  const sourceLink = item.chatId.toString().startsWith("-100")
    ? `https://t.me/c/${item.chatId.toString().slice(4)}/${item.messageId}`
    : `Сообщение №${item.messageId}`;
  return [
    item.action === "delete"
      ? "Запрос на удаление сообщения. Действие пока не выполнено."
      : "Подозрительное сообщение в чате. Бан пока не выполнен.",
    `Автор: ${item.authorLabel} (ID ${item.userId})`,
    `Впервые замечен: ${item.firstSeenAt.toISOString().slice(0, 10)}. Получено сообщений: ${item.messageCount}.`,
    "Это история наблюдений бота, а не возраст аккаунта.",
    item.requestedBy
      ? `Запрос администратора (ID ${item.requestedBy}).`
      : `Оценка AI: ${item.category === "advertising" ? "реклама" : "подозрительная активность"}.`,
    `Причина${item.requestedBy ? " запроса" : " AI"}: ${excerpt(item.reason ?? "Не указана", 600)}`,
    "Текст сообщения:",
    excerpt(item.text, 1200),
    sourceLink,
    item.action === "delete"
      ? "Удаление требует твоего подтверждения и доступно в пределах срока Telegram (обычно 48 часов)."
      : "Решить можно в течение 7 дней. Бан — навсегда, с удалением всех сообщений этого участника в этой группе. Сообщения остальных останутся.",
  ].join("\n\n");
}

export function createModerationActions(
  config: AppConfig,
  api: ModerationApi,
  generateBanAnnouncement?: () => Promise<string>,
): ModerationActions {
  const protectedIds = new Set(config.protectedUserIds ?? []);
  if (config.ownerUserId !== undefined) protectedIds.add(config.ownerUserId);

  async function canModerate(item: ReviewCase): Promise<boolean> {
    if (!config.moderationEnabled || config.ownerUserId === undefined) return false;
    const chat = await api.getChat(Number(item.chatId));
    if (!isAllowedGroup(chat, config) || chat.id !== Number(item.chatId)) return false;

    const owner = await api.getChatMember(Number(item.chatId), config.ownerUserId);
    if (owner.user.id !== config.ownerUserId) return false;
    if (owner.status !== "creator" && owner.status !== "administrator") {
      console.warn("Moderation owner is not a group administrator", {
        chatId: item.chatId.toString(),
      });
      return false;
    }
    if (
      owner.status === "administrator" &&
      !(item.action === "delete" ? owner.can_delete_messages : owner.can_restrict_members)
    ) {
      console.warn("Moderation owner lacks required permissions", {
        chatId: item.chatId.toString(),
        action: item.action ?? "ban",
      });
      return false;
    }
    return true;
  }

  const eligibility: ModerationActions["eligibility"] = async (item) => {
    if (item.action === "delete" && item.sentAt.getTime() <= Date.now() - 48 * 60 * 60 * 1000)
      return "denied";
    if (Number(item.userId) === config.ownerUserId || protectedIds.has(Number(item.userId)))
      return "protected";
    if (!(await canModerate(item))) return "denied";

    const target = await api.getChatMember(Number(item.chatId), Number(item.userId));
    if (target.user.id !== Number(item.userId)) return "denied";
    if (
      target.status === "creator" ||
      target.status === "administrator" ||
      target.status === "kicked"
    ) {
      return "protected";
    }
    if (target.status === "left" || (target.status === "restricted" && !target.is_member)) {
      return "denied";
    }
    return target.status === "member" || (target.status === "restricted" && target.is_member)
      ? "allowed"
      : "denied";
  };

  return {
    eligibility,
    async notify(item) {
      if ((await eligibility(item)) !== "allowed") return undefined;
      const message = await api.sendMessage(config.ownerUserId!, reviewText(item), {
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: item.action === "delete" ? "Удалить сообщение" : "Забанить навсегда",
                callback_data: `mod:${item.action === "delete" ? "delete" : "ban"}:${item.id}`,
              },
              { text: "Оставить", callback_data: `mod:keep:${item.id}` },
            ],
          ],
        },
      });
      return message.message_id;
    },
    async ban(item, current) {
      const allowed = await eligibility(item);
      if (allowed !== "allowed") return allowed;
      if (!(await current())) return "denied";
      await api.banChatMember(Number(item.chatId), Number(item.userId), { revoke_messages: true });
      return "allowed";
    },
    async announceBan(item) {
      if (item.status !== "banned" || !(await canModerate(item))) return false;
      let text = "С этим разобралась, сообщения забаненного участника убрала. Продолжаем разговор.";
      if (generateBanAnnouncement) {
        try {
          text = await generateBanAnnouncement();
        } catch {
          console.warn("Ban announcement generation failed", { caseId: item.id });
        }
      }
      // Permissions may change while the model is generating its reply.
      if (!(await canModerate(item))) return false;
      await api.sendMessage(Number(item.chatId), text, {
        ...(item.topicId ? { message_thread_id: item.topicId } : {}),
        disable_notification: true,
      });
      return true;
    },
    async deleteMessage(item, current) {
      const allowed = await eligibility(item);
      if (allowed !== "allowed") return allowed;
      if (!(await current())) return "denied";
      await api.deleteMessage(Number(item.chatId), item.messageId);
      return "allowed";
    },
  };
}

export function moderationMiddleware(config: AppConfig, moderation: Moderation): MiddlewareFn {
  return async (ctx, next) => {
    const message = ctx.message ?? ctx.editedMessage;
    const text = message?.text ?? message?.caption ?? "";
    if (
      !config.moderationEnabled ||
      !message ||
      (!text && !ctx.editedMessage) ||
      !message.from ||
      message.sender_chat ||
      (message.chat.type !== "group" && message.chat.type !== "supergroup") ||
      !isMemoryChat(ctx, config)
    ) {
      await next();
      return;
    }
    const replied = message.reply_to_message;
    const replyText = replied?.text ?? replied?.caption ?? "";
    console.info("Moderation message received", {
      chatId: message.chat.id,
      messageId: message.message_id,
      updateId: ctx.update.update_id,
    });
    try {
      await moderation.observe({
        updateId: ctx.update.update_id,
        chatId: BigInt(message.chat.id),
        userId: BigInt(message.from.id),
        messageId: message.message_id,
        topicId: message.message_thread_id ?? 0,
        text: excerpt(text, 4000),
        replyText: excerpt(replyText, 1200),
        authorLabel: excerpt(
          `${message.from.first_name}${message.from.username ? ` (@${message.from.username})` : ""}`,
          120,
        ),
        isBot: message.from.is_bot,
        sentAt: new Date(message.date * 1000),
      });
    } catch {
      console.error("Moderation observation failed", {
        chatId: message.chat.id,
        messageId: message.message_id,
        updateId: ctx.update.update_id,
      });
    }
    await next();
  };
}

export function createModerationCallback(config: AppConfig, moderation: Moderation) {
  return async (ctx: Context): Promise<void> => {
    const query = ctx.callbackQuery;
    const message = query?.message;
    const match = /^mod:(ban|delete|keep):([a-f0-9-]{36})$/.exec(query?.data ?? "");
    if (!query || !match) return;
    if (
      !config.moderationEnabled ||
      config.ownerUserId === undefined ||
      query.from.is_bot ||
      query.from.id !== config.ownerUserId ||
      message?.chat.type !== "private" ||
      message.chat.id !== config.ownerUserId ||
      !("date" in message) ||
      message.date === 0
    ) {
      await ctx.answerCallbackQuery({ text: "Это действие доступно только владельцу." });
      return;
    }
    // Acknowledge immediately; authorization and the Telegram action may take longer.
    await ctx.answerCallbackQuery({ text: "Проверяю заявку…" }).catch(() => undefined);
    try {
      const result = await moderation.decide(
        match[2]!,
        query.from.id,
        message.message_id,
        match[1] as "ban" | "delete" | "keep",
      );
      await ctx.api.sendMessage(config.ownerUserId, result, {
        reply_parameters: { message_id: message.message_id },
      });
    } catch {
      console.error("Moderation callback failed", { updateId: ctx.update.update_id });
      await ctx.api.sendMessage(
        config.ownerUserId,
        "Не удалось обработать заявку. Проверь статус участника; подтверждённый бан повторно не выполняется.",
      );
    }
  };
}
