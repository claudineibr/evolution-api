CREATE TABLE `MetaWebhookInbox` (
  `id` VARCHAR(64) NOT NULL,
  `payload` JSON NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `MetaWebhookInbox_completedAt_availableAt_idx` (`completedAt`, `availableAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
