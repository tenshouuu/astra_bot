import type { Context, Filter } from "grammy";

export function addressedQuestion(ctx: Filter<Context, "message:text">): string | undefined {
  const message = ctx.message;
  if (message.entities?.some((entity) => entity.type === "bot_command" && entity.offset === 0)) {
    return undefined;
  }
  const mentions = (message.entities ?? []).filter(
    (entity) =>
      (entity.type === "mention" &&
        message.text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
          `@${ctx.me.username.toLowerCase()}`) ||
      (entity.type === "text_mention" && entity.user.id === ctx.me.id),
  );
  // Some received messages contain a literal @username without a mention entity.
  for (const match of message.text.matchAll(/(?<![\p{L}\p{N}_@/])@([a-zA-Z0-9_]+)/gu)) {
    if (match[1]?.toLowerCase() !== ctx.me.username.toLowerCase()) continue;
    const offset = match.index;
    const length = match[0].length;
    const overlapsEntity = message.entities?.some(
      (entity) =>
        entity.offset < offset + length &&
        entity.offset + entity.length > offset &&
        ["mention", "text_mention", "code", "pre", "text_link", "url", "email"].includes(
          entity.type,
        ),
    );
    if (!overlapsEntity) mentions.push({ type: "mention", offset, length });
  }
  const replied = message.reply_to_message;
  const repliesToBot =
    replied?.from?.id === ctx.me.id &&
    replied.from.is_bot &&
    !replied.sender_chat &&
    replied.chat.id === ctx.chat.id;
  if (!repliesToBot && mentions.length === 0) return undefined;

  let question = message.text;
  // Telegram offsets use UTF-16, as does String.slice. Remove from the end to preserve offsets.
  for (const entity of mentions.sort((left, right) => right.offset - left.offset)) {
    question = `${question.slice(0, entity.offset)}${question.slice(entity.offset + entity.length)}`;
  }
  return question.trim();
}
