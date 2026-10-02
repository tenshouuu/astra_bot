import type { PrismaClient } from "@prisma/client";
import { MAX_QUEUED_CASES, REVIEW_LIFETIME_MS } from "@app/modules/moderation/types";
import type { ModerationStore } from "@app/modules/moderation/types";

export function createModerationStore(db: PrismaClient): ModerationStore {
  return {
    async observe(input) {
      await db.$transaction(async (tx) => {
        if (await tx.moderationCase.findUnique({ where: { updateId: input.updateId } })) return;

        const sourceId = `${input.chatId}:${input.messageId}`;
        const existing = await tx.moderationMessage.findUnique({ where: { sourceId } });
        const previouslyObserved =
          existing ??
          (await tx.moderationCase.findFirst({
            where: { chatId: input.chatId, messageId: input.messageId },
            select: { id: true },
          }));
        // A repeated or edited message does not count as another contribution.
        const participant = await tx.moderationParticipant.upsert({
          where: { chatId_userId: { chatId: input.chatId, userId: input.userId } },
          create: {
            chatId: input.chatId,
            userId: input.userId,
            firstSeenAt: input.sentAt,
            messageCount: 1,
          },
          update: { messageCount: { increment: previouslyObserved ? 0 : 1 } },
        });
        await tx.moderationMessage.upsert({
          where: { sourceId },
          create: {
            sourceId,
            chatId: input.chatId,
            userId: input.userId,
            messageId: input.messageId,
            topicId: input.topicId ?? 0,
            text: input.text,
            sentAt: input.sentAt,
          },
          update: { text: input.text, topicId: input.topicId ?? 0 },
        });
        await tx.moderationCase.updateMany({
          where: {
            chatId: input.chatId,
            messageId: input.messageId,
            status: { in: ["queued", "analyzing", "notifying", "review"] },
          },
          data: { status: "expired" },
        });
        const queued = await tx.moderationCase.count({
          where: { status: { in: ["queued", "analyzing"] } },
        });
        await tx.moderationCase.create({
          data: {
            ...input,
            firstSeenAt: participant.firstSeenAt,
            messageCount: participant.messageCount,
            expiresAt: new Date(Date.now() + REVIEW_LIFETIME_MS),
            status: !input.text.trim()
              ? "clean"
              : queued >= MAX_QUEUED_CASES
                ? "overloaded"
                : "queued",
          },
        });
      });
    },
    queued(limit) {
      const now = new Date();
      return db.moderationCase.findMany({
        where: { status: "queued", availableAt: { lte: now }, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
    },
    async claimAnalysis(id) {
      const result = await db.moderationCase.updateMany({
        where: { id, status: "queued", expiresAt: { gt: new Date() } },
        data: { status: "analyzing", attempts: { increment: 1 } },
      });
      return result.count === 1;
    },
    async history(item) {
      const messages = await db.moderationMessage.findMany({
        where: {
          chatId: item.chatId,
          userId: item.userId,
          messageId: { not: item.messageId },
          sentAt: {
            lte: item.sentAt,
            gte: new Date(Date.now() - REVIEW_LIFETIME_MS),
          },
        },
        orderBy: { sentAt: "desc" },
        take: 12,
        select: { text: true },
      });
      return messages.reverse().map((message) => message.text);
    },
    get(id) {
      return db.moderationCase.findUnique({ where: { id } });
    },
    search(chatId, topicId, query, userId) {
      return db.moderationMessage.findMany({
        where: {
          chatId,
          ...(topicId === undefined ? {} : { topicId }),
          ...(userId === null ? {} : { userId }),
          text: { contains: query, mode: "insensitive", not: "" },
          sentAt: { gte: new Date(Date.now() - REVIEW_LIFETIME_MS) },
        },
        select: { messageId: true, userId: true, text: true, sentAt: true },
        orderBy: { sentAt: "desc" },
        take: 3,
      });
    },
    source(chatId, topicId, messageId) {
      return db.moderationCase.findFirst({
        where: { chatId, messageId, ...(topicId === undefined ? {} : { topicId }) },
        orderBy: { updateId: "desc" },
      });
    },
    async isCurrent(item) {
      const latest = await db.moderationCase.findFirst({
        where: { chatId: item.chatId, messageId: item.messageId },
        orderBy: { updateId: "desc" },
        select: { id: true },
      });
      return latest?.id === item.id;
    },
    async hasOpenReview(item) {
      return (
        (await db.moderationCase.count({
          where: {
            chatId: item.chatId,
            userId: item.userId,
            id: { not: item.id },
            status: { in: ["notifying", "review", "banning", "deleting"] },
          },
        })) > 0
      );
    },
    async transition(id, from, to, change = {}) {
      const result = await db.moderationCase.updateMany({
        where: {
          id,
          status: from,
          ...(to === "notifying" || to === "banning" || to === "deleting" || to === "review"
            ? { expiresAt: { gt: new Date() } }
            : {}),
        },
        data: { ...change, status: to },
      });
      return result.count === 1;
    },
    async recover() {
      await db.moderationCase.updateMany({
        where: { status: "analyzing", attempts: { gte: 3 } },
        data: { status: "failed" },
      });
      await db.moderationCase.updateMany({
        where: { status: "analyzing" },
        data: { status: "queued" },
      });
      // Telegram delivery/action may have succeeded. Never repeat an ambiguous side effect.
      await db.moderationCase.updateMany({
        where: { status: { in: ["notifying", "banning", "deleting"] } },
        data: { status: "unknown" },
      });
    },
    async prune() {
      const now = new Date();
      await db.$transaction([
        db.moderationCase.updateMany({
          where: {
            expiresAt: { lte: now },
            status: { in: ["queued", "analyzing", "notifying", "review"] },
          },
          data: { status: "expired" },
        }),
        db.moderationCase.updateMany({
          where: {
            expiresAt: { lte: now },
            OR: [
              { text: { not: "" } },
              { replyText: { not: "" } },
              { authorLabel: { not: "" } },
              { reason: { not: null } },
            ],
          },
          data: { text: "", replyText: "", authorLabel: "", reason: null },
        }),
        db.moderationMessage.deleteMany({
          where: { sentAt: { lt: new Date(Date.now() - REVIEW_LIFETIME_MS) } },
        }),
      ]);
    },
  };
}
