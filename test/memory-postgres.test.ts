import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createDatabase, createMemoryStore } from "@app/modules/memory/store";

const databaseUrl = process.env.TEST_DATABASE_URL;

void test(
  "PostgreSQL memory persists, isolates topics, deduplicates and resets safely",
  { skip: !databaseUrl },
  async (context) => {
    const db = createDatabase(databaseUrl!);
    const store = createMemoryStore(db);
    const prefix = `test:${randomUUID()}`;
    context.after(async () => {
      await db.conversation.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.$disconnect();
    });
    const group = `${prefix}:group:0`;
    const topic = `${prefix}:group:1`;
    const privateChat = `${prefix}:private:0`;
    const message = {
      conversationId: group,
      externalId: `${prefix}:first`,
      role: "user" as const,
      author: "Synthetic author",
      text: "Synthetic group context",
      sentAt: new Date(),
    };
    await store.append(message);
    await store.append(message);
    await store.append({
      ...message,
      conversationId: topic,
      externalId: `${prefix}:topic`,
      text: "Synthetic topic context",
    });
    await store.append({
      ...message,
      conversationId: privateChat,
      externalId: `${prefix}:private`,
      text: "Synthetic private context",
    });
    await store.append({ ...message, externalId: `${prefix}:current`, text: "Question" });
    await store.append({ ...message, externalId: `${prefix}:future`, text: "Future message" });
    const snapshot = await store.context(group, `${prefix}:current`);
    assert.deepEqual(
      snapshot.messages.map((item) => item.text),
      ["Synthetic group context"],
    );
    const first = snapshot.messages[0];
    assert.ok(first);
    await store.saveSummary(group, snapshot.summary, "Group summary", first.id);
    // Stale writers cannot overwrite a newer summary.
    await store.saveSummary(group, snapshot.summary, "Stale summary", first.id);
    const secondClient = createDatabase(databaseUrl!);
    try {
      const reloaded = await createMemoryStore(secondClient).context(group, `${prefix}:current`);
      assert.equal(reloaded.summary.text, "Group summary");
      assert.deepEqual(reloaded.messages, []);
    } finally {
      await secondClient.$disconnect();
    }
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const expired = `${prefix}:expired`;
    await store.append({
      ...message,
      conversationId: expired,
      externalId: `${prefix}:expired`,
      sentAt: oldDate,
    });
    await db.conversation.update({ where: { id: expired }, data: { updatedAt: oldDate } });
    await store.prune(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    assert.equal(await db.conversation.findUnique({ where: { id: expired } }), null);
    const beforeReset = await store.pending(group);
    await store.reset(group);
    await store.saveSummary(group, beforeReset.summary, "Stale after reset", first.id);
    assert.equal((await store.pending(group)).summary.text, "");
    assert.deepEqual((await store.pending(group)).messages, []);
    assert.equal((await store.pending(topic)).messages.length, 1);
    assert.equal((await store.pending(privateChat)).messages.length, 1);
  },
);
