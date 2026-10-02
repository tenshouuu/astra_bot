import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase } from "@app/modules/memory/store";
import { createModerationStore } from "@app/modules/moderation/store";
import { createModeration } from "@app/modules/moderation/service";
import type { Observation } from "@app/modules/moderation/types";
import { REVIEW_LIFETIME_MS } from "@app/modules/moderation/types";

const databaseUrl = process.env.TEST_DATABASE_URL;

void test(
  "PostgreSQL moderation deduplicates, isolates history, invalidates edits and persists review decisions",
  { skip: !databaseUrl },
  async (context) => {
    const db = createDatabase(databaseUrl!);
    const store = createModerationStore(db);
    const chatId = -BigInt(Date.now());
    // Telegram update IDs are global; use a distinct synthetic range for this database test.
    const firstUpdate = 1_500_000_000 + Math.floor(Math.random() * 100_000_000);
    const input: Observation = {
      updateId: firstUpdate,
      chatId,
      userId: 2n,
      messageId: 10,
      text: "Продам USDT — synthetic",
      replyText: "",
      authorLabel: "Synthetic",
      isBot: false,
      sentAt: new Date(),
    };
    context.after(async () => {
      await db.moderationCase.deleteMany({ where: { chatId: { in: [chatId, chatId - 1n] } } });
      await db.moderationMessage.deleteMany({ where: { chatId: { in: [chatId, chatId - 1n] } } });
      await db.moderationParticipant.deleteMany({
        where: { chatId: { in: [chatId, chatId - 1n] } },
      });
      await db.$disconnect();
    });

    await store.observe(input);
    await store.observe(input);
    assert.equal(await db.moderationCase.count({ where: { chatId } }), 1);
    assert.equal(
      (
        await db.moderationParticipant.findUniqueOrThrow({
          where: { chatId_userId: { chatId, userId: 2n } },
        })
      ).messageCount,
      1,
    );
    const original = await db.moderationCase.findUniqueOrThrow({
      where: { updateId: firstUpdate },
    });
    assert.deepEqual(await store.history(original), []);
    await store.observe({
      ...input,
      updateId: firstUpdate + 1,
      chatId: chatId - 1n,
      messageId: 11,
      text: "Different group",
    });
    await store.observe({
      ...input,
      updateId: firstUpdate + 2,
      userId: 3n,
      messageId: 12,
      text: "Different participant",
    });
    await store.observe({
      ...input,
      updateId: firstUpdate + 3,
      messageId: 13,
      text: "Synthetic previous discussion",
    });
    const current = await db.moderationCase.findUniqueOrThrow({
      where: { updateId: firstUpdate + 3 },
    });
    assert.deepEqual(await store.history(current), [input.text]);
    assert.equal(current.messageCount, 2);

    await store.transition(original.id, "queued", "review", { notificationMessageId: 90 });
    await store.observe({ ...input, updateId: firstUpdate + 4, text: "Synthetic edited text" });
    assert.equal((await store.get(original.id))?.status, "expired");
    assert.equal(await store.isCurrent(original), false);
    assert.equal(
      (
        await db.moderationParticipant.findUniqueOrThrow({
          where: { chatId_userId: { chatId, userId: 2n } },
        })
      ).messageCount,
      2,
    );

    // Concurrent notification claims are constrained by the database, not only an in-memory check.
    const edited = await db.moderationCase.findUniqueOrThrow({
      where: { updateId: firstUpdate + 4 },
    });
    const claims = await Promise.allSettled([
      store.transition(current.id, "queued", "notifying"),
      store.transition(edited.id, "queued", "notifying"),
    ]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled" && claim.value).length, 1);
    await store.recover();
    assert.equal(await db.moderationCase.count({ where: { chatId, status: "unknown" } }), 1);

    await db.moderationCase.updateMany({
      where: { chatId: { in: [chatId, chatId - 1n] } },
      data: { status: "clean" },
    });
    await store.observe({ ...input, updateId: firstUpdate + 5, messageId: 15 });
    const review = await db.moderationCase.findUniqueOrThrow({
      where: { updateId: firstUpdate + 5 },
    });
    let notifications = 0;
    let bans = 0;
    const moderation = createModeration(
      store,
      async () => ({ category: "advertising", reason: "Продажа USDT" }),
      {
        eligibility: async () => "allowed",
        notify: async () => {
          notifications++;
          return 91;
        },
        ban: async () => {
          bans++;
          return "allowed";
        },
      },
      1,
    );
    await moderation.runPending();
    await moderation.wait();
    assert.equal(notifications, 1);
    assert.equal(bans, 0);
    assert.equal((await store.get(review.id))?.status, "review");
    await Promise.all([
      moderation.decide(review.id, 1, 91, "ban"),
      moderation.decide(review.id, 1, 91, "ban"),
    ]);
    assert.equal(bans, 1);
    await moderation.close();

    const secondDb = createDatabase(databaseUrl!);
    try {
      const reloaded = await createModerationStore(secondDb).get(review.id);
      assert.equal(reloaded?.status, "banned");
      assert.equal(reloaded?.decidedBy, 1n);
      assert.ok(reloaded?.decidedAt);
    } finally {
      await secondDb.$disconnect();
    }

    const expiredAt = new Date(Date.now() - REVIEW_LIFETIME_MS - 1000);
    await db.moderationCase.updateMany({ where: { chatId }, data: { expiresAt: expiredAt } });
    await db.moderationMessage.updateMany({ where: { chatId }, data: { sentAt: expiredAt } });
    await db.moderationCase.createMany({
      data: [
        { text: "Synthetic remaining text" },
        { replyText: "Synthetic remaining reply" },
        { authorLabel: "Synthetic remaining author" },
        { reason: "Synthetic remaining explanation" },
        { reason: "" },
      ].map((fields, index) => ({
        ...input,
        updateId: firstUpdate + 20 + index,
        firstSeenAt: input.sentAt,
        messageCount: 1,
        status: "clean",
        expiresAt: expiredAt,
        text: "",
        replyText: "",
        authorLabel: "",
        ...fields,
      })),
    });
    await store.prune();
    assert.equal((await store.get(review.id))?.text, "");
    assert.equal((await store.get(review.id))?.reason, null);
    assert.equal((await store.get(review.id))?.status, "banned");
    assert.equal(await db.moderationMessage.count({ where: { chatId } }), 0);
    assert.equal(
      (
        await db.moderationParticipant.findUniqueOrThrow({
          where: { chatId_userId: { chatId, userId: 2n } },
        })
      ).messageCount,
      3,
    );

    const cleaned = await db.moderationCase.findMany({ where: { chatId } });
    assert.ok(
      cleaned.every(
        (item) =>
          item.text === "" &&
          item.replyText === "" &&
          item.authorLabel === "" &&
          item.reason === null,
      ),
    );
    // Fix timestamps to detect an UPDATE on the next run without a timing-dependent sleep.
    await db.moderationCase.updateMany({
      where: { chatId },
      data: { updatedAt: new Date("2000-01-01T00:00:00Z") },
    });
    const beforeSecondPrune = await db.moderationCase.findMany({
      where: { chatId },
      orderBy: { id: "asc" },
    });
    const unexpiredBefore = await db.moderationCase.findUniqueOrThrow({
      where: { updateId: firstUpdate + 1 },
    });
    await store.prune();
    assert.deepEqual(
      await db.moderationCase.findMany({ where: { chatId }, orderBy: { id: "asc" } }),
      beforeSecondPrune,
    );
    assert.deepEqual(await store.get(unexpiredBefore.id), unexpiredBefore);
  },
);

void test(
  "PostgreSQL empty-caption edits clear current search, invalidate review and never queue analysis",
  { skip: !databaseUrl },
  async (context) => {
    const db = createDatabase(databaseUrl!);
    const store = createModerationStore(db);
    const chatId = -BigInt(Date.now()) - 10_000n;
    const updateId = 1_800_000_000 + Math.floor(Math.random() * 100_000_000);
    context.after(async () => {
      await db.moderationCase.deleteMany({ where: { chatId } });
      await db.moderationMessage.deleteMany({ where: { chatId } });
      await db.moderationParticipant.deleteMany({ where: { chatId } });
      await db.$disconnect();
    });
    const input: Observation = {
      updateId,
      chatId,
      userId: 3n,
      messageId: 20,
      topicId: 7,
      text: "Synthetic promotional caption",
      replyText: "",
      authorLabel: "Synthetic",
      isBot: false,
      sentAt: new Date(),
    };
    await store.observe(input);
    const original = await store.source(chatId, 7, 20);
    assert.ok(original);
    assert.equal(
      await store.transition(original.id, "queued", "review", { notificationMessageId: 55 }),
      true,
    );
    await store.observe({ ...input, updateId: updateId + 1, text: "" });
    await store.observe({ ...input, updateId: updateId + 1, text: "" });
    assert.equal((await store.get(original.id))?.status, "expired");
    assert.equal(await store.isCurrent(original), false);
    assert.deepEqual(await store.search(chatId, 7, "", null), []);
    assert.deepEqual(await store.search(chatId, 7, "promotional", null), []);
    const empty = await store.source(chatId, 7, 20);
    assert.ok(empty);
    assert.equal(empty.text, "");
    assert.equal(empty.status, "clean");
    assert.equal(await store.claimAnalysis(empty.id), false);
    assert.equal(await db.moderationCase.count({ where: { chatId } }), 2);
    const participant = await db.moderationParticipant.findUniqueOrThrow({
      where: { chatId_userId: { chatId, userId: 3n } },
    });
    assert.equal(participant.messageCount, 1);
    const moderation = createModeration(
      store,
      async () => assert.fail("Empty edit must not be classified"),
      {
        eligibility: async () => assert.fail("Stale source must not check action permissions"),
        notify: async () => assert.fail("No notification for empty content"),
        ban: async () => assert.fail("Old button must not ban"),
        deleteMessage: async () => assert.fail("Old button must not delete"),
      },
      1,
    );
    try {
      assert.equal(
        await moderation.decide(original.id, 1, 55, "ban"),
        "Заявка уже обработана или недоступна.",
      );
      assert.equal(
        await moderation.requestReview(empty.id, 1, "delete", "Synthetic", async () => true),
        "source_unavailable",
      );
    } finally {
      await moderation.close();
    }
  },
);
