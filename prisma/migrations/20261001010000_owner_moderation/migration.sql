-- CreateTable
CREATE TABLE "ModerationParticipant" (
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModerationParticipant_pkey" PRIMARY KEY ("chatId","userId")
);

-- CreateTable
CREATE TABLE "ModerationMessage" (
    "sourceId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationMessage_pkey" PRIMARY KEY ("sourceId")
);

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "updateId" INTEGER NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "authorLabel" TEXT NOT NULL,
    "isBot" BOOLEAN NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT,
    "reason" TEXT,
    "notificationMessageId" INTEGER,
    "decidedBy" BIGINT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationMessage_chatId_userId_sentAt_idx" ON "ModerationMessage"("chatId", "userId", "sentAt");

-- CreateIndex
CREATE INDEX "ModerationMessage_sentAt_idx" ON "ModerationMessage"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModerationCase_updateId_key" ON "ModerationCase"("updateId");

-- CreateIndex
CREATE INDEX "ModerationCase_status_availableAt_idx" ON "ModerationCase"("status", "availableAt");

-- CreateIndex
CREATE INDEX "ModerationCase_chatId_userId_status_idx" ON "ModerationCase"("chatId", "userId", "status");

-- CreateIndex
CREATE INDEX "ModerationCase_expiresAt_idx" ON "ModerationCase"("expiresAt");

CREATE INDEX "ModerationCase_chatId_messageId_updateId_idx" ON "ModerationCase"("chatId", "messageId", "updateId");

-- Concurrent analyses must not send two active ban requests for the same participant.
CREATE UNIQUE INDEX "ModerationCase_active_target_key"
ON "ModerationCase"("chatId", "userId")
WHERE "status" IN ('notifying', 'review', 'banning');
