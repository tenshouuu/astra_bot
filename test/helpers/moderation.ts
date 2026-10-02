import { randomUUID } from "node:crypto";
import type { ModerationStore, ReviewCase } from "@app/modules/moderation/types";
import { REVIEW_LIFETIME_MS } from "@app/modules/moderation/types";

export function fakeModerationStore() {
  const cases = new Map<string, ReviewCase>();
  const store: ModerationStore = {
    async search(chatId, topicId, query, userId) {
      const messages = new Map<string, ReviewCase>();
      for (const item of cases.values()) messages.set(`${item.chatId}:${item.messageId}`, item);
      return [...messages.values()]
        .filter(
          (item) =>
            item.text !== "" &&
            item.chatId === chatId &&
            (topicId === undefined || (item.topicId ?? 0) === topicId) &&
            (userId === null || item.userId === userId) &&
            item.text.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(-3)
        .map((item) => ({
          messageId: item.messageId,
          userId: item.userId,
          text: item.text,
          sentAt: item.sentAt,
        }));
    },
    async source(chatId, topicId, messageId) {
      const item = [...cases.values()]
        .filter(
          (item) =>
            item.chatId === chatId &&
            item.messageId === messageId &&
            (topicId === undefined || (item.topicId ?? 0) === topicId),
        )
        .at(-1);
      return item ? { ...item } : null;
    },
    async observe(input) {
      if ([...cases.values()].some((item) => item.updateId === input.updateId)) return;
      const previous = [...cases.values()].filter(
        (item) => item.chatId === input.chatId && item.userId === input.userId,
      );
      for (const item of previous) {
        if (
          item.messageId === input.messageId &&
          ["queued", "analyzing", "notifying", "review"].includes(item.status)
        ) {
          item.status = "expired";
        }
      }
      const id = randomUUID();
      cases.set(id, {
        ...input,
        id,
        firstSeenAt: previous[0]?.firstSeenAt ?? input.sentAt,
        messageCount: new Set([...previous.map((item) => item.messageId), input.messageId]).size,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + REVIEW_LIFETIME_MS),
        status: input.text.trim() ? "queued" : "clean",
        attempts: 0,
        availableAt: new Date(),
        category: null,
        reason: null,
        notificationMessageId: null,
        decidedBy: null,
        decidedAt: null,
      });
    },
    async queued(limit) {
      return [...cases.values()]
        .filter((item) => item.status === "queued" && item.availableAt.getTime() <= Date.now())
        .slice(0, limit)
        .map((item) => ({ ...item }));
    },
    async claimAnalysis(id) {
      const item = cases.get(id);
      if (item?.status !== "queued") return false;
      item.status = "analyzing";
      item.attempts++;
      return true;
    },
    async history(current) {
      return [...cases.values()]
        .filter(
          (item) =>
            item.chatId === current.chatId &&
            item.userId === current.userId &&
            item.messageId !== current.messageId &&
            item.updateId < current.updateId,
        )
        .map((item) => item.text);
    },
    async get(id) {
      const item = cases.get(id);
      return item ? { ...item } : null;
    },
    async isCurrent(current) {
      return ![...cases.values()].some(
        (item) =>
          item.chatId === current.chatId &&
          item.messageId === current.messageId &&
          item.updateId > current.updateId,
      );
    },
    async hasOpenReview(current) {
      return [...cases.values()].some(
        (item) =>
          item.id !== current.id &&
          item.chatId === current.chatId &&
          item.userId === current.userId &&
          ["notifying", "review", "banning", "deleting"].includes(item.status),
      );
    },
    async transition(id, from, to, change = {}) {
      const item = cases.get(id);
      if (item?.status !== from) return false;
      Object.assign(item, change, { status: to });
      return true;
    },
    async recover() {},
    async prune() {},
  };
  return { store, cases };
}
