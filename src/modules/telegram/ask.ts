import type { AppConfig } from "@app/config/env";
import type { ConversationMemory } from "@app/modules/memory/service";
import { contextMessage } from "@app/modules/memory/context";
import type { ContextMessage } from "@app/modules/memory/types";
import { canAsk } from "@app/modules/telegram/access";
import { conversationId, messageId, messageAuthor } from "@app/modules/telegram/memory";
import type { Ask } from "@app/modules/openai/api";
import type { CommandContext, Context } from "grammy";

const MAX_QUESTION_LENGTH = 8000;
const MESSAGE_CHUNK_SIZE = 3500;
const COLLAPSIBLE_ANSWER_LENGTH = 1000;
const RECENT_UPDATE_LIMIT = 1000;
const MAX_PENDING_REQUESTS = 8;

type AskContext = CommandContext<Context>;

async function checkAccess(ctx: AskContext, config: AppConfig): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await canAsk(ctx, config);
  } catch {
    await ctx.reply("Не смогла проверить, могу ли я тебе отвечать. Попробуй ещё раз чуть позже.");
    return false;
  }

  if (!allowed) {
    await ctx.reply(
      "Пока я отвечаю только администраторам нашей группы, а владельцу — ещё и в личке.",
    );
  }
  return allowed;
}

function questionError(question: string): string | undefined {
  if (!question) return "Я слушаю. Напиши вопрос после /ask.";
  if (question.length > MAX_QUESTION_LENGTH) {
    return `Вопрос слишком длинный для одного сообщения. Сократи его до ${MAX_QUESTION_LENGTH} символов, и разберёмся.`;
  }
  return undefined;
}

async function requestAnswer(
  ctx: AskContext,
  ask: Ask,
  question: string,
  memory?: ConversationMemory,
): Promise<string | undefined> {
  await ctx.replyWithChatAction("typing").catch(() => undefined);

  try {
    let context: ContextMessage[] = [];
    if (memory) {
      await memory.record({
        conversationId: conversationId(ctx),
        externalId: messageId(ctx),
        role: "user",
        author: messageAuthor(ctx),
        text: question,
        sentAt: new Date(ctx.msg.date * 1000),
      });
      context = await memory.context(conversationId(ctx), messageId(ctx));
    }
    const replied = ctx.msg.reply_to_message;
    if (replied?.text && (replied.message_thread_id ?? 0) === (ctx.msg.message_thread_id ?? 0)) {
      context.push(
        contextMessage({
          id: 0n,
          role: "user",
          author: `Quoted reply from ${replied.from?.username ?? replied.from?.first_name ?? "unknown"}`,
          text: replied.text,
        }),
      );
    }
    context.push({ role: "user", content: JSON.stringify({ current_author: messageAuthor(ctx) }) });
    return await ask(question, context);
  } catch {
    console.error("AI request failed", { updateId: ctx.update.update_id });
    await ctx.reply("С ответом не вышло. Попробуй спросить ещё раз чуть позже.");
    return undefined;
  }
}

export function splitAnswer(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > MESSAGE_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function sendAnswer(ctx: AskContext, config: AppConfig, answer: string): Promise<boolean> {
  for (const chunk of splitAnswer(answer)) {
    // Access may change between individual Telegram sends.
    if (!(await canAsk(ctx, config))) return false;

    await ctx.reply(chunk, {
      reply_parameters: { message_id: ctx.msg.message_id },
      link_preview_options: { is_disabled: true },
      ...(answer.length > COLLAPSIBLE_ANSWER_LENGTH
        ? {
            entities: [{ type: "expandable_blockquote" as const, offset: 0, length: chunk.length }],
          }
        : {}),
    });
  }
  return true;
}

export function createAskHandler(config: AppConfig, ask: Ask, memory?: ConversationMemory) {
  const pendingRequests = new Set<string>();
  const recentUpdates = new Set<number>();
  const jobs = new Map<string, Promise<void>>();
  let closing = false;

  async function waitForRequests(): Promise<void> {
    await Promise.all(jobs.values());
  }

  function isDuplicate(updateId: number): boolean {
    if (recentUpdates.has(updateId)) return true;

    recentUpdates.add(updateId);
    if (recentUpdates.size > RECENT_UPDATE_LIMIT) {
      const oldestUpdate = recentUpdates.values().next().value;
      if (oldestUpdate !== undefined) recentUpdates.delete(oldestUpdate);
    }
    return false;
  }

  const handler = async (ctx: AskContext): Promise<void> => {
    if (closing) return;
    if (isDuplicate(ctx.update.update_id)) return;
    if (!(await checkAccess(ctx, config))) return;

    const question = ctx.match.trim();
    const validationError = questionError(question);
    if (validationError) {
      await ctx.reply(validationError);
      return;
    }

    const requestKey = `${ctx.chat.id}:${ctx.from?.id}`;
    if (pendingRequests.has(requestKey)) {
      await ctx.reply("Я ещё разбираюсь с твоим предыдущим вопросом. Дай мне немного времени.");
      return;
    }

    const scope = conversationId(ctx);
    if (jobs.has(scope)) {
      await ctx.reply("Я ещё отвечаю на вопрос в этом диалоге. Закончу — возьмусь за следующий.");
      return;
    }
    if (jobs.size >= MAX_PENDING_REQUESTS) {
      await ctx.reply("Сейчас у меня много вопросов. Попробуй чуть позже.");
      return;
    }
    if (closing) return;

    pendingRequests.add(requestKey);
    const job = (async () => {
      const answer = await requestAnswer(ctx, ask, question, memory);
      if (answer === undefined) return;

      if (!(await sendAnswer(ctx, config, answer))) return;
      if (memory) {
        await memory.record({
          conversationId: conversationId(ctx),
          externalId: `answer:${messageId(ctx)}`,
          role: "assistant",
          author: "Astra",
          text: answer,
          sentAt: new Date(),
        });
        memory.refresh(conversationId(ctx));
      }
    })()
      .catch(() => {
        console.error("Telegram AI job failed", { updateId: ctx.update.update_id });
      })
      .finally(() => {
        pendingRequests.delete(requestKey);
        jobs.delete(scope);
      });
    jobs.set(scope, job);
  };

  return Object.assign(handler, {
    waitForRequests,
    isPending: (scope: string) => jobs.has(scope),
    close: async () => {
      closing = true;
      await waitForRequests();
    },
  });
}

export function createResetHandler(
  config: AppConfig,
  memory: ConversationMemory,
  isPending: (scope: string) => boolean,
) {
  return async (ctx: AskContext): Promise<void> => {
    if (!(await checkAccess(ctx, config))) return;
    if (isPending(conversationId(ctx))) {
      await ctx.reply("Дай мне сначала закончить ответ, а потом начнём с чистого листа.");
      return;
    }

    await memory.reset(conversationId(ctx));
    await ctx.reply("Начнём с чистого листа. Предыдущий разговор больше не учитываю.");
  };
}
