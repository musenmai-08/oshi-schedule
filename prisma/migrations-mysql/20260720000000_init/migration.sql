-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `supabaseUserId` VARCHAR(64) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `onboardingCompletedAt` DATETIME(3) NULL,
    `reauthRequired` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_supabaseUserId_key`(`supabaseUserId`),
    INDEX `User_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GoogleCredential` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `encryptedRefreshToken` TEXT NOT NULL,
    `keyId` VARCHAR(32) NOT NULL,
    `scopes` TEXT NOT NULL,
    `tokenUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GoogleCredential_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CalendarConnection` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `googleCalendarId` VARCHAR(255) NULL,
    `status` ENUM('NOT_CONNECTED', 'ACTIVE', 'MISSING', 'ERROR') NOT NULL DEFAULT 'NOT_CONNECTED',
    `lastCheckedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CalendarConnection_userId_key`(`userId`),
    UNIQUE INDEX `CalendarConnection_googleCalendarId_key`(`googleCalendarId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `YouTubeChannel` (
    `id` VARCHAR(191) NOT NULL,
    `youtubeChannelId` VARCHAR(64) NOT NULL,
    `handle` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `thumbnailUrl` TEXT NOT NULL,
    `channelUrl` TEXT NOT NULL,
    `lastFetchedAt` DATETIME(3) NULL,
    `etag` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `YouTubeChannel_youtubeChannelId_key`(`youtubeChannelId`),
    INDEX `YouTubeChannel_handle_idx`(`handle`),
    INDEX `YouTubeChannel_lastFetchedAt_idx`(`lastFetchedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserChannelSubscription` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'PAUSED') NOT NULL DEFAULT 'ACTIVE',
    `lastCalendarSyncAt` DATETIME(3) NULL,
    `lastManualSyncAt` DATETIME(3) NULL,
    `lastSyncStatus` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'SKIPPED') NULL,
    `lastErrorCode` VARCHAR(64) NULL,
    `lastErrorMessage` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserChannelSubscription_userId_status_idx`(`userId`, `status`),
    INDEX `UserChannelSubscription_channelId_status_idx`(`channelId`, `status`),
    UNIQUE INDEX `UserChannelSubscription_userId_channelId_key`(`userId`, `channelId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScheduledBroadcast` (
    `id` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(191) NOT NULL,
    `youtubeVideoId` VARCHAR(32) NOT NULL,
    `title` VARCHAR(500) NOT NULL,
    `kind` ENUM('LIVE', 'PREMIERE') NOT NULL,
    `status` ENUM('UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED', 'UNKNOWN') NOT NULL DEFAULT 'UPCOMING',
    `youtubeUrl` TEXT NOT NULL,
    `thumbnailUrl` TEXT NOT NULL,
    `scheduledStartAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `endTimeProvisional` BOOLEAN NOT NULL DEFAULT true,
    `actualStartAt` DATETIME(3) NULL,
    `actualEndAt` DATETIME(3) NULL,
    `missingCount` INTEGER NOT NULL DEFAULT 0,
    `sourceUpdatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ScheduledBroadcast_youtubeVideoId_key`(`youtubeVideoId`),
    INDEX `ScheduledBroadcast_channelId_scheduledStartAt_idx`(`channelId`, `scheduledStartAt`),
    INDEX `ScheduledBroadcast_status_scheduledStartAt_idx`(`status`, `scheduledStartAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CalendarEventMapping` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `broadcastId` VARCHAR(191) NOT NULL,
    `googleCalendarEventId` VARCHAR(255) NOT NULL,
    `managedFieldsHash` VARCHAR(64) NOT NULL,
    `lastSyncedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CalendarEventMapping_googleCalendarEventId_idx`(`googleCalendarEventId`),
    UNIQUE INDEX `CalendarEventMapping_userId_broadcastId_key`(`userId`, `broadcastId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SyncRun` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('SCHEDULED', 'MANUAL') NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'RUNNING',
    `requestedById` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `channelsTotal` INTEGER NOT NULL DEFAULT 0,
    `usersTotal` INTEGER NOT NULL DEFAULT 0,
    `apiCalls` INTEGER NOT NULL DEFAULT 0,
    `errorCode` VARCHAR(64) NULL,

    INDEX `SyncRun_type_status_startedAt_idx`(`type`, `status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SyncTargetResult` (
    `id` VARCHAR(191) NOT NULL,
    `syncRunId` VARCHAR(191) NOT NULL,
    `targetType` ENUM('CHANNEL', 'USER', 'SUBSCRIPTION') NOT NULL,
    `targetId` VARCHAR(64) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'SKIPPED') NOT NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(255) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `SyncTargetResult_targetType_targetId_startedAt_idx`(`targetType`, `targetId`, `startedAt`),
    UNIQUE INDEX `SyncTargetResult_syncRunId_targetType_targetId_key`(`syncRunId`, `targetType`, `targetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountDeletionRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `status` ENUM('REQUESTED', 'CALENDAR_DELETED', 'TOKEN_REVOKED', 'DATA_DELETED', 'AUTH_DELETED', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'REQUESTED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastErrorCode` VARCHAR(64) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AccountDeletionRequest_userId_key`(`userId`),
    INDEX `AccountDeletionRequest_status_requestedAt_idx`(`status`, `requestedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `GoogleCredential` ADD CONSTRAINT `GoogleCredential_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CalendarConnection` ADD CONSTRAINT `CalendarConnection_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserChannelSubscription` ADD CONSTRAINT `UserChannelSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserChannelSubscription` ADD CONSTRAINT `UserChannelSubscription_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `YouTubeChannel`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ScheduledBroadcast` ADD CONSTRAINT `ScheduledBroadcast_channelId_fkey` FOREIGN KEY (`channelId`) REFERENCES `YouTubeChannel`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CalendarEventMapping` ADD CONSTRAINT `CalendarEventMapping_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CalendarEventMapping` ADD CONSTRAINT `CalendarEventMapping_broadcastId_fkey` FOREIGN KEY (`broadcastId`) REFERENCES `ScheduledBroadcast`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SyncRun` ADD CONSTRAINT `SyncRun_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SyncTargetResult` ADD CONSTRAINT `SyncTargetResult_syncRunId_fkey` FOREIGN KEY (`syncRunId`) REFERENCES `SyncRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountDeletionRequest` ADD CONSTRAINT `AccountDeletionRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
