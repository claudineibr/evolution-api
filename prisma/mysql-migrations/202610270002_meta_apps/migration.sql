CREATE TABLE `MetaApp` (
    `id` VARCHAR(36) NOT NULL,
    `companyId` VARCHAR(36) NOT NULL,
    `appId` VARCHAR(50) NOT NULL,
    `activeAppId` VARCHAR(50) NULL,
    `publicId` VARCHAR(64) NOT NULL,
    `appSecret` TEXT NOT NULL,
    `verifyToken` TEXT NOT NULL,
    `callbackVerifiedAt` TIMESTAMP(3) NULL,
    `lastEventAt` TIMESTAMP(3) NULL,
    `deletedAt` TIMESTAMP(3) NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `MetaApp_activeAppId_key` (`activeAppId`),
    UNIQUE INDEX `MetaApp_publicId_key` (`publicId`),
    INDEX `MetaApp_companyId_idx` (`companyId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `Instance` ADD COLUMN `metaAppId` VARCHAR(36) NULL;
CREATE INDEX `Instance_metaAppId_idx` ON `Instance`(`metaAppId`);
ALTER TABLE `Instance` ADD CONSTRAINT `Instance_metaAppId_fkey` FOREIGN KEY (`metaAppId`) REFERENCES `MetaApp`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `MetaWebhookInbox` ADD COLUMN `metaAppId` VARCHAR(36) NULL;
CREATE INDEX `MetaWebhookInbox_metaAppId_idx` ON `MetaWebhookInbox`(`metaAppId`);
ALTER TABLE `MetaWebhookInbox` ADD CONSTRAINT `MetaWebhookInbox_metaAppId_fkey` FOREIGN KEY (`metaAppId`) REFERENCES `MetaApp`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
UPDATE `MetaWebhookInbox` SET `completedAt` = CURRENT_TIMESTAMP(3) WHERE `metaAppId` IS NULL AND `completedAt` IS NULL;
