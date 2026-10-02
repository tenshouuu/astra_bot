BEGIN;

-- Older observations do not contain topic metadata. Keep them out of topic-scoped searches.
ALTER TABLE "ModerationMessage" ADD COLUMN "topicId" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "ModerationMessage" ALTER COLUMN "topicId" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "ModerationCase" ADD COLUMN     "action" TEXT NOT NULL DEFAULT 'ban',
ADD COLUMN     "requestedBy" BIGINT,
ADD COLUMN     "topicId" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "ModerationCase" ALTER COLUMN "topicId" SET DEFAULT 0;

-- CreateIndex
CREATE INDEX "ModerationMessage_chatId_topicId_sentAt_idx" ON "ModerationMessage"("chatId", "topicId", "sentAt");
-- Include deletion confirmations in the one-active-review-per-participant constraint.
DROP INDEX "ModerationCase_active_target_key";
CREATE UNIQUE INDEX "ModerationCase_active_target_key"
ON "ModerationCase"("chatId", "userId")
WHERE "status" IN ('notifying', 'review', 'banning', 'deleting');

COMMIT;
