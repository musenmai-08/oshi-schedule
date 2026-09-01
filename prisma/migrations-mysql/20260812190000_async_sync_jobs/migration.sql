-- Reuse SyncRun as a durable asynchronous job with explicit queue and claim timestamps.
ALTER TABLE `SyncRun`
  MODIFY `type` ENUM('SCHEDULED', 'INITIAL', 'MANUAL') NOT NULL,
  MODIFY `status` ENUM('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN `queuedAt` DATETIME(3) NULL,
  ADD COLUMN `heartbeatAt` DATETIME(3) NULL,
  MODIFY `startedAt` DATETIME(3) NULL;

UPDATE `SyncRun`
SET `queuedAt` = `startedAt`,
    `heartbeatAt` = IF(`status` = 'RUNNING', `startedAt`, `completedAt`);

ALTER TABLE `SyncRun`
  MODIFY `queuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE INDEX `SyncRun_status_queuedAt_idx` ON `SyncRun`(`status`, `queuedAt`);

ALTER TABLE `SyncTargetResult`
  MODIFY `status` ENUM('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL,
  ADD COLUMN `queuedAt` DATETIME(3) NULL,
  MODIFY `startedAt` DATETIME(3) NULL;

UPDATE `SyncTargetResult`
SET `queuedAt` = `startedAt`;

ALTER TABLE `SyncTargetResult`
  MODIFY `queuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `UserChannelSubscription`
  MODIFY `lastSyncStatus` ENUM('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED') NULL;
