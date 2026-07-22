-- Persist channel fetch lifecycle and immutable snapshot sequence for cross-worker fan-out.
ALTER TABLE `YouTubeChannel`
  ADD COLUMN `fetchStartedAt` DATETIME(3) NULL,
  ADD COLUMN `fetchCompletedAt` DATETIME(3) NULL,
  ADD COLUMN `lastFetchSucceededAt` DATETIME(3) NULL,
  ADD COLUMN `snapshotVersion` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastFetchStatus` ENUM('NEVER', 'RUNNING', 'SUCCESS', 'DEFERRED', 'FAILED') NOT NULL DEFAULT 'NEVER',
  ADD COLUMN `nextFetchAt` DATETIME(3) NULL;

UPDATE `YouTubeChannel`
SET `fetchCompletedAt` = `lastFetchedAt`,
    `lastFetchSucceededAt` = `lastFetchedAt`,
    `snapshotVersion` = IF(`lastFetchedAt` IS NULL, 0, 1),
    `lastFetchStatus` = IF(`lastFetchedAt` IS NULL, 'NEVER', 'SUCCESS');

CREATE INDEX `YouTubeChannel_lastFetchStatus_nextFetchAt_idx`
  ON `YouTubeChannel`(`lastFetchStatus`, `nextFetchAt`);

ALTER TABLE `SyncRun`
  MODIFY `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'RUNNING';
ALTER TABLE `UserChannelSubscription`
  MODIFY `lastSyncStatus` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED') NULL;
ALTER TABLE `SyncTargetResult`
  MODIFY `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL,
  ADD COLUMN `youtubeFetchStatus` ENUM('NOT_STARTED', 'SUCCESS', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN `databaseUpdateStatus` ENUM('NOT_STARTED', 'SUCCESS', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN `calendarSyncStatus` ENUM('NOT_STARTED', 'SUCCESS', 'DEFERRED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN `snapshotVersion` INTEGER NULL;
