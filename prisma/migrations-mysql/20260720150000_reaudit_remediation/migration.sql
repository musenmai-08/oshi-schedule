-- Add fencing to leases so an expired owner cannot write after a successor acquires the key.
ALTER TABLE `SyncLease`
  ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;

-- Keep the search.list bucket separate from the general YouTube Data API unit bucket.
CREATE TABLE `YouTubeQuotaUsage` (
  `quotaDate` CHAR(10) NOT NULL,
  `bucket` ENUM('GENERAL', 'SEARCH') NOT NULL,
  `unitsUsed` INTEGER NOT NULL DEFAULT 0,
  `unitsReserved` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `YouTubeQuotaUsage_updatedAt_idx`(`updatedAt`),
  PRIMARY KEY (`quotaDate`, `bucket`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
