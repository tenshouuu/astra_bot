import type { AppConfig } from "@app/config/env";
import type { ConversationMemory } from "@app/modules/memory/service";
import { contextMessage } from "@app/modules/memory/context";
import type { ContextMessage } from "@app/modules/memory/types";
import { canAsk, canManageChat } from "@app/modules/telegram/access";
import { addressedQuestion, hasNameCandidate } from "@app/modules/telegram/address";
import type { DetectAddress } from "@app/modules/openai/address";
import type { DetectContinuation } from "@app/modules/openai/continuation";
import { createDialogues } from "@app/modules/telegram/dialogue";
import type { DialogueTurn } from "@app/modules/memory/types";
import { conversationId, messageId, messageAuthor } from "@app/modules/telegram/memory";
import type { Ask } from "@app/modules/openai/api";
import type { AssistantRuntime } from "@app/modules/openai/tools";
import type { CommandContext, Context, Filter } from "grammy";

const MAX_QUESTION_LENGTH = 8000;
const MESSAGE_CHUNK_SIZE = 3500;
const COLLAPSIBLE_ANSWER_LENGTH = 1000;
const COLLAPSIBLE_ANSWER_LINES = 12;
const RECENT_UPDATE_LIMIT = 1000;
const MAX_PENDING_REQUESTS = 8;
const REQUEST_FAILURE_MESSAGE = "С ответом не вышло. Попробуй спросить ещё раз чуть позже.";

type AskContext = CommandContext<Context> | Filter<Context, "message:text">;

async function checkAccess(
  ctx: AskContext,
  config: AppConfig,
  manage = false,
  silent = false,
): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await (manage ? canManageChat(ctx, config) : canAsk(ctx, config));
  } catch {
    if (!silent)
      await ctx.reply("Не смогла проверить, могу ли я тебе отвечать. Попробуй ещё раз чуть позже.");
    return false;
  }

  if (!allowed && !silent) {
    await ctx.reply(
      manage
        ? "Управлять чатом могут только администраторы нашей группы, а владелец — ещё и в личке."
        : "Я отвечаю участникам нашей группы, а владельцу — ещё и в личке.",
    );
  }
  return allowed;
}

function questionError(question: string): string | undefined {
  if (!question) return "Я слушаю. Напиши вопрос.";
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
  runtime?: AssistantRuntime,
  recentTurns: readonly DialogueTurn[] = [],
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
    for (const turn of recentTurns) {
      context.push(
        contextMessage({
          id: 0n,
          role: turn.authorId === null ? "assistant" : "user",
          author: turn.authorId === null ? "Astra" : `Telegram user ${turn.authorId}`,
          text: turn.text,
        }),
      );
    }
    context.push({ role: "user", content: JSON.stringify({ current_author: messageAuthor(ctx) }) });
    return await ask(question, context, runtime);
  } catch {
    console.error("AI request failed", { updateId: ctx.update.update_id });
    await ctx.reply(REQUEST_FAILURE_MESSAGE);
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

async function sendAnswer(
  ctx: AskContext,
  config: AppConfig,
  answer: string,
  runtime?: AssistantRuntime,
): Promise<boolean> {
  const collapsible =
    answer.length > COLLAPSIBLE_ANSWER_LENGTH ||
    answer.split(/\r\n|\r|\n/u).length >= COLLAPSIBLE_ANSWER_LINES;
  for (const chunk of splitAnswer(answer)) {
    // Access may change between individual Telegram sends.
    if (!(await canAsk(ctx, config))) return false;
    if (runtime?.authorizeResponse && !(await runtime.authorizeResponse())) return false;

    await ctx.reply(chunk, {
      reply_parameters: { message_id: ctx.msg.message_id },
      link_preview_options: { is_disabled: true },
      ...(collapsible
        ? {
            entities: [{ type: "expandable_blockquote" as const, offset: 0, length: chunk.length }],
          }
        : {}),
    });
  }
  return true;
}

export function createAskHandler(
  config: AppConfig,
  ask: Ask,
  memory?: ConversationMemory,
  tools?: (ctx: AskContext) => Promise<AssistantRuntime>,
  detectAddress?: DetectAddress,
  detectContinuation?: DetectContinuation,
) {
  const dialogues = createDialogues();
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

  const handleQuestion = async (
    ctx: AskContext,
    question: string,
    trigger: "explicit" | "name" | "continuation" = "explicit",
  ): Promise<void> => {
    const implicit = trigger !== "explicit";
    if (closing) return;
    if (isDuplicate(ctx.update.update_id)) return;
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      console.info("Telegram assistant request received", {
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        updateId: ctx.update.update_id,
      });
    }
    if (!(await checkAccess(ctx, config, false, implicit))) return;

    const validationError = questionError(question);
    if (validationError) {
      if (!implicit) await ctx.reply(validationError);
      return;
    }

    const requestKey = `${ctx.chat.id}:${ctx.from?.id}`;
    const scope = conversationId(ctx);
    const dialogue = dialogues.get(scope);
    const recentTurns = dialogue?.turns.slice() ?? [];
    const turn = { authorId: ctx.from!.id, text: question };
    dialogues.observe(scope, turn);
    if (pendingRequests.has(requestKey)) {
      if (!implicit)
        await ctx.reply("Я ещё разбираюсь с твоим предыдущим вопросом. Дай мне немного времени.");
      return;
    }

    if (jobs.has(scope)) {
      if (!implicit)
        await ctx.reply("Я ещё отвечаю на вопрос в этом диалоге. Закончу — возьмусь за следующий.");
      return;
    }
    if (jobs.size >= MAX_PENDING_REQUESTS) {
      if (!implicit) await ctx.reply("Сейчас у меня много вопросов. Попробуй чуть позже.");
      return;
    }
    if (closing) return;

    pendingRequests.add(requestKey);
    const job = (async () => {
      let closesConversation = false;
      if (implicit) {
        const replied = ctx.msg.reply_to_message;
        const sameTopic = (replied?.message_thread_id ?? 0) === (ctx.msg.message_thread_id ?? 0);
        const evidence = {
          text: question,
          replyText: sameTopic ? (replied?.text ?? replied?.caption ?? "").slice(0, 1200) : "",
          repliesToOther: !!replied && replied.from?.id !== ctx.me.id,
        };
        let addressed: boolean | undefined;
        if (trigger === "continuation") {
          if (!dialogue || dialogues.get(scope) !== dialogue) return;
          const decision = await detectContinuation?.({
            ...evidence,
            authorId: ctx.from!.id,
            recentTurns,
          });
          if (dialogues.get(scope) !== dialogue) return;
          addressed = decision?.addressed;
          closesConversation = decision?.closesConversation ?? false;
        } else addressed = await detectAddress?.(evidence);
        if (!addressed || !(await checkAccess(ctx, config, false, true))) return;
        if (closesConversation) dialogues.clear(scope);
      }
      let runtime: AssistantRuntime | undefined;
      try {
        runtime = tools ? await tools(ctx) : undefined;
        if (runtime && closesConversation) {
          runtime = {
            ...runtime,
            requestContext: { ...runtime.requestContext, conversation_closing: true },
          };
        }
      } catch {
        console.error("Assistant tool initialization failed", { updateId: ctx.update.update_id });
        await ctx.reply(REQUEST_FAILURE_MESSAGE);
        return;
      }
      const answer = await requestAnswer(
        ctx,
        ask,
        question,
        memory,
        runtime,
        trigger === "continuation" ? recentTurns : [],
      );
      if (answer === undefined) return;

      if (!(await sendAnswer(ctx, config, answer, runtime))) return;
      if (detectContinuation && !closesConversation) dialogues.answered(scope, turn, answer);
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

  const handler = (ctx: CommandContext<Context>) => handleQuestion(ctx, ctx.match.trim());
  return Object.assign(handler, {
    addressed: async (ctx: Filter<Context, "message:text">) => {
      const question = addressedQuestion(ctx);
      if (question !== undefined) await handleQuestion(ctx, question);
      else if (detectAddress && hasNameCandidate(ctx))
        await handleQuestion(ctx, ctx.message.text, "name");
      else if (
        detectContinuation &&
        dialogues.get(conversationId(ctx)) &&
        !ctx.message.forward_origin &&
        !ctx.message.text.startsWith("/") &&
        !ctx.message.entities?.some((entity) =>
          ["code", "pre", "blockquote", "expandable_blockquote"].includes(entity.type),
        )
      )
        await handleQuestion(ctx, ctx.message.text, "continuation");
    },
    waitForRequests,
    isPending: (scope: string) => jobs.has(scope),
    clearDialogue: (scope: string) => dialogues.clear(scope),
    close: async () => {
      closing = true;
      await waitForRequests();
      dialogues.close();
    },
  });
}

export function createResetHandler(
  config: AppConfig,
  memory: ConversationMemory,
  isPending: (scope: string) => boolean,
  clearDialogue?: (scope: string) => void,
) {
  return async (ctx: AskContext): Promise<void> => {
    if (!(await checkAccess(ctx, config, true))) return;
    if (isPending(conversationId(ctx))) {
      await ctx.reply("Дай мне сначала закончить ответ, а потом начнём с чистого листа.");
      return;
    }

    await memory.reset(conversationId(ctx));
    clearDialogue?.(conversationId(ctx));
    await ctx.reply("Начнём с чистого листа. Предыдущий разговор больше не учитываю.");
  };
}
