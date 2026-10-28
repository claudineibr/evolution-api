CREATE TABLE "MetaApp" (
    "id" VARCHAR(36) NOT NULL,
    "companyId" VARCHAR(36) NOT NULL,
    "appId" VARCHAR(50) NOT NULL,
    "activeAppId" VARCHAR(50),
    "publicId" VARCHAR(64) NOT NULL,
    "appSecret" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "callbackVerifiedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "MetaApp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MetaApp_activeAppId_key" ON "MetaApp"("activeAppId");
CREATE UNIQUE INDEX "MetaApp_publicId_key" ON "MetaApp"("publicId");
CREATE INDEX "MetaApp_companyId_idx" ON "MetaApp"("companyId");
ALTER TABLE "Instance" ADD COLUMN "metaAppId" VARCHAR(36);
CREATE INDEX "Instance_metaAppId_idx" ON "Instance"("metaAppId");
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_metaAppId_fkey" FOREIGN KEY ("metaAppId") REFERENCES "MetaApp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MetaWebhookInbox" ADD COLUMN "metaAppId" VARCHAR(36);
CREATE INDEX "MetaWebhookInbox_metaAppId_idx" ON "MetaWebhookInbox"("metaAppId");
ALTER TABLE "MetaWebhookInbox" ADD CONSTRAINT "MetaWebhookInbox_metaAppId_fkey" FOREIGN KEY ("metaAppId") REFERENCES "MetaApp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE "MetaWebhookInbox" SET "completedAt" = CURRENT_TIMESTAMP WHERE "metaAppId" IS NULL AND "completedAt" IS NULL;
