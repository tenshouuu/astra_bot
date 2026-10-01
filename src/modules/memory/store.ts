import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MemoryStore, NewMessage, Summary } from "@app/modules/memory/types";

const EMPTY_SUMMARY: Summary = { text: "", throughId: 0n, version: 0 };

export function createDatabase(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, max: 5 }),
  });
}

export function createMemoryStore(db: PrismaClient): MemoryStore {
  return {
    async append(message: NewMessage) {
      await db.$transaction(async (tx) => {
        await tx.conversation.upsert({
          where: { id: message.conversationId },
          create: { id: message.conversationId, summary: { create: {} } },
          update: { updatedAt: new Date() },
        });
        await tx.message.upsert({
          where: { externalId: message.externalId },
          create: message,
          update: {},
        });
      });
    },
    async context(conversationId, beforeExternalId) {
      const current = await db.message.findUnique({ where: { externalId: beforeExternalId } });
      if (!current || current.conversationId !== conversationId) {
        throw new Error("Current message is missing from conversation");
      }
      const summary = await db.conversationSummary.findUnique({ where: { conversationId } });
      const usableSummary = summary && summary.throughId < current.id ? summary : EMPTY_SUMMARY;
      const messages = await db.message.findMany({
        where: { conversationId, id: { lt: current.id, gt: usableSummary.throughId } },
        orderBy: { id: "desc" },
        take: 60,
      });
      // A newer summary must not leak future turns into an earlier request.
      return { summary: usableSummary, messages: messages.reverse() };
    },
    async pending(conversationId) {
      const summary = await db.conversationSummary.findUnique({ where: { conversationId } });
      const messages = await db.message.findMany({
        where: { conversationId, id: { gt: summary?.throughId ?? 0n } },
        orderBy: { id: "asc" },
        take: 80,
      });
      return { summary: summary ?? EMPTY_SUMMARY, messages };
    },
    async saveSummary(conversationId, previous, text, throughId) {
      await db.conversationSummary.updateMany({
        where: { conversationId, version: previous.version, throughId: previous.throughId },
        data: { text, throughId, version: { increment: 1 } },
      });
    },
    async reset(conversationId) {
      await db.$transaction([
        db.message.deleteMany({ where: { conversationId } }),
        db.conversationSummary.updateMany({
          where: { conversationId },
          data: { text: "", throughId: 0n, version: { increment: 1 } },
        }),
      ]);
    },
    async prune(before) {
      await db.$transaction([
        db.message.deleteMany({ where: { sentAt: { lt: before } } }),
        db.conversation.deleteMany({ where: { updatedAt: { lt: before } } }),
      ]);
    },
  };
}
