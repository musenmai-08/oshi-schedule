-- Extend broadcast classification without rewriting the initial migration.
ALTER TABLE `ScheduledBroadcast`
  MODIFY `kind` ENUM('LIVE', 'PREMIERE', 'UNKNOWN') NOT NULL,
  MODIFY `status` ENUM('UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED', 'UNKNOWN', 'UNAVAILABLE') NOT NULL DEFAULT 'UPCOMING';

-- Keep deletion tombstones after the local User row has been removed.
ALTER TABLE `AccountDeletionRequest` DROP FOREIGN KEY `AccountDeletionRequest_userId_fkey`;
ALTER TABLE `AccountDeletionRequest`
  MODIFY `userId` VARCHAR(191) NULL,
  ADD COLUMN `supabaseUserId` VARCHAR(64) NULL,
  ADD COLUMN `calendarIdSnapshot` VARCHAR(255) NULL,
  ADD COLUMN `calendarDeletedAt` DATETIME(3) NULL,
  ADD COLUMN `googleTokenRevokedAt` DATETIME(3) NULL,
  ADD COLUMN `userDataDeletedAt` DATETIME(3) NULL,
  ADD COLUMN `supabaseUserDeletedAt` DATETIME(3) NULL;

UPDATE `AccountDeletionRequest` AS deletionRequest
INNER JOIN `User` AS appUser ON appUser.`id` = deletionRequest.`userId`
SET deletionRequest.`supabaseUserId` = appUser.`supabaseUserId`;

ALTER TABLE `AccountDeletionRequest`
  MODIFY `supabaseUserId` VARCHAR(64) NOT NULL,
  ADD UNIQUE INDEX `AccountDeletionRequest_supabaseUserId_key`(`supabaseUserId`),
  ADD CONSTRAINT `AccountDeletionRequest_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `SyncLease` (
  `key` VARCHAR(191) NOT NULL,
  `ownerToken` VARCHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `SyncLease_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
