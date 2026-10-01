import {
  contextMessage,
  limitText,
  MESSAGE_BYTES,
  recentMessages,
  SUMMARY_BYTES,
  SUMMARY_INPUT_BYTES,
  HISTORY_BYTES,
} from "@app/modules/memory/context";
import type { ContextMessage, MemoryStore, NewMessage, Summarize } from "@app/modules/memory/types";

const COMPACT_AFTER_MESSAGES = 40;
const KEEP_RECENT_MESSAGES = 12;
const MAX_SUMMARY_JOBS = 2;
const MAX_QUEUED_SUMMARIES = 64;
const MAX_RECENT_ATTEMPTS = 128;
const SUMMARY_RETRY_MS = 30_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createMemory(store: MemoryStore, summarize: Summarize) {
  const jobs = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const lastAttempt = new Map<string, number>();
  const resetting = new Set<string>();
  const refreshTimer = setInterval(drainQueue, SUMMARY_RETRY_MS);
  refreshTimer.unref();
  let lastPrunedAt = 0;
  let closing = false;

  async function compact(conversationId: string): Promise<void> {
    const { summary, messages } = await store.pending(conversationId);
    const size = messages.reduce(
      (total, message) => total + Buffer.byteLength(contextMessage(message).content),
      0,
    );
    if (messages.length < COMPACT_AFTER_MESSAGES && size <= HISTORY_BYTES) return;
    const keep = Math.max(1, Math.min(KEEP_RECENT_MESSAGES, recentMessages(messages).length));

    const batch: ContextMessage[] = [];
    let bytes = 0;
    let throughId = summary.throughId;
    for (const message of messages.slice(0, -keep)) {
      const item = contextMessage(message);
      const size = Buffer.byteLength(item.content);
      if (bytes + size > SUMMARY_INPUT_BYTES) break;
      batch.push(item);
      bytes += size;
      throughId = message.id;
    }
    if (!batch.length) return;
    const text = await summarize(summary.text, batch);
    if (!text.trim()) throw new Error("Empty conversation summary");
    await store.saveSummary(conversationId, summary, limitText(text, SUMMARY_BYTES), throughId);
    if (batch.length < messages.length - keep || messages.length === 80) enqueue(conversationId);
  }

  function enqueue(conversationId: string): void {
    if (closing || resetting.has(conversationId)) return;
    // Overflow drops scheduling only; persisted messages remain available on the next refresh.
    if (queued.size < MAX_QUEUED_SUMMARIES) queued.add(conversationId);
  }

  function drainQueue(): void {
    if (closing) return;

    for (const conversationId of queued) {
      if (jobs.size >= MAX_SUMMARY_JOBS) break;
      if (jobs.has(conversationId) || resetting.has(conversationId)) continue;
      if (Date.now() - (lastAttempt.get(conversationId) ?? -Infinity) < SUMMARY_RETRY_MS) {
        continue;
      }

      queued.delete(conversationId);
      lastAttempt.delete(conversationId);
      lastAttempt.set(conversationId, Date.now());
      if (lastAttempt.size > MAX_RECENT_ATTEMPTS) {
        const oldest = lastAttempt.keys().next().value;
        if (oldest !== undefined) lastAttempt.delete(oldest);
      }

      const job = compact(conversationId)
        .catch(() => {
          console.error("Conversation summary update failed");
          enqueue(conversationId);
        })
        .finally(() => {
          jobs.delete(conversationId);
          drainQueue();
        });
      jobs.set(conversationId, job);
    }
  }

  function refresh(conversationId: string): void {
    enqueue(conversationId);
    drainQueue();
  }

  return {
    async record(message: NewMessage): Promise<void> {
      await store.append({ ...message, text: limitText(message.text, MESSAGE_BYTES) });
    },
    async context(conversationId: string, currentExternalId: string): Promise<ContextMessage[]> {
      const { summary, messages } = await store.context(conversationId, currentExternalId);
      const context = recentMessages(messages);
      if (summary.text) {
        context.unshift({
          role: "user",
          content: JSON.stringify({ conversation_summary: summary.text }),
        });
      }
      return context;
    },
    refresh,
    async reset(conversationId: string): Promise<void> {
      resetting.add(conversationId);
      queued.delete(conversationId);
      try {
        await jobs.get(conversationId);
        await store.reset(conversationId);
        lastAttempt.delete(conversationId);
      } finally {
        resetting.delete(conversationId);
      }
    },
    async prune(): Promise<void> {
      const now = Date.now();
      if (now - lastPrunedAt < 60 * 60 * 1000) return;
      await store.prune(new Date(now - RETENTION_MS));
      lastPrunedAt = now;
      for (const [conversationId, attemptedAt] of lastAttempt) {
        if (attemptedAt < now - RETENTION_MS) lastAttempt.delete(conversationId);
      }
    },
    async close(): Promise<void> {
      closing = true;
      clearInterval(refreshTimer);
      queued.clear();
      await Promise.all(jobs.values());
      lastAttempt.clear();
    },
  };
}

export type ConversationMemory = ReturnType<typeof createMemory>;
