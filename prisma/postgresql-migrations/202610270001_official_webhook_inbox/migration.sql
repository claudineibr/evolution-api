CREATE TABLE "MetaWebhookInbox" (
  "id" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetaWebhookInbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MetaWebhookInbox_completedAt_availableAt_idx" ON "MetaWebhookInbox"("completedAt", "availableAt");
