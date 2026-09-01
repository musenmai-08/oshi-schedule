-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- Keep application tables outside Supabase's exposed schemas. Runtime and
-- migration roles receive explicit grants during environment provisioning.
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;

-- CreateEnum
CREATE TYPE "app"."SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "app"."BroadcastKind" AS ENUM ('LIVE', 'PREMIERE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "app"."BroadcastStatus" AS ENUM ('UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED', 'UNKNOWN', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "app"."ConnectionStatus" AS ENUM ('NOT_CONNECTED', 'ACTIVE', 'MISSING', 'ERROR');

-- CreateEnum
CREATE TYPE "app"."SyncRunType" AS ENUM ('SCHEDULED', 'INITIAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "app"."SyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'PARTIAL_FAILED', 'DEFERRED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "app"."ChannelFetchStatus" AS ENUM ('NEVER', 'RUNNING', 'SUCCESS', 'DEFERRED', 'FAILED');

-- CreateEnum
CREATE TYPE "app"."SyncPhaseStatus" AS ENUM ('NOT_STARTED', 'SUCCESS', 'DEFERRED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "app"."TargetType" AS ENUM ('CHANNEL', 'USER', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "app"."DeletionStatus" AS ENUM ('REQUESTED', 'CALENDAR_DELETED', 'TOKEN_REVOKED', 'DATA_DELETED', 'AUTH_DELETED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "app"."YouTubeQuotaBucket" AS ENUM ('GENERAL', 'SEARCH');

-- CreateTable
CREATE TABLE "app"."User" (
    "id" TEXT NOT NULL,
    "supabaseUserId" VARCHAR(64) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "onboardingCompletedAt" TIMESTAMPTZ(3),
    "reauthRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."GoogleCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "keyId" VARCHAR(32) NOT NULL,
    "scopes" TEXT NOT NULL,
    "tokenUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GoogleCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."CalendarConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleCalendarId" VARCHAR(255),
    "status" "app"."ConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."YouTubeChannel" (
    "id" TEXT NOT NULL,
    "youtubeChannelId" VARCHAR(64) NOT NULL,
    "handle" VARCHAR(64) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "thumbnailUrl" TEXT NOT NULL,
    "channelUrl" TEXT NOT NULL,
    "lastFetchedAt" TIMESTAMPTZ(3),
    "fetchStartedAt" TIMESTAMPTZ(3),
    "fetchCompletedAt" TIMESTAMPTZ(3),
    "lastFetchSucceededAt" TIMESTAMPTZ(3),
    "snapshotVersion" INTEGER NOT NULL DEFAULT 0,
    "lastFetchStatus" "app"."ChannelFetchStatus" NOT NULL DEFAULT 'NEVER',
    "nextFetchAt" TIMESTAMPTZ(3),
    "etag" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "YouTubeChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."UserChannelSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "app"."SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastCalendarSyncAt" TIMESTAMPTZ(3),
    "lastManualSyncAt" TIMESTAMPTZ(3),
    "lastSyncStatus" "app"."SyncStatus",
    "lastErrorCode" VARCHAR(64),
    "lastErrorMessage" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserChannelSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."ScheduledBroadcast" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "youtubeVideoId" VARCHAR(32) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "kind" "app"."BroadcastKind" NOT NULL,
    "status" "app"."BroadcastStatus" NOT NULL DEFAULT 'UPCOMING',
    "youtubeUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT NOT NULL,
    "scheduledStartAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "endTimeProvisional" BOOLEAN NOT NULL DEFAULT true,
    "actualStartAt" TIMESTAMPTZ(3),
    "actualEndAt" TIMESTAMPTZ(3),
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "sourceUpdatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduledBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."CalendarEventMapping" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "googleCalendarEventId" VARCHAR(255) NOT NULL,
    "managedFieldsHash" VARCHAR(64) NOT NULL,
    "lastSyncedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CalendarEventMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."SyncRun" (
    "id" TEXT NOT NULL,
    "type" "app"."SyncRunType" NOT NULL,
    "status" "app"."SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "requestedById" TEXT,
    "queuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "channelsTotal" INTEGER NOT NULL DEFAULT 0,
    "usersTotal" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(64),

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."SyncTargetResult" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "targetType" "app"."TargetType" NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "status" "app"."SyncStatus" NOT NULL,
    "errorCode" VARCHAR(64),
    "errorMessage" VARCHAR(255),
    "queuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "youtubeFetchStatus" "app"."SyncPhaseStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "databaseUpdateStatus" "app"."SyncPhaseStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "calendarSyncStatus" "app"."SyncPhaseStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "snapshotVersion" INTEGER,

    CONSTRAINT "SyncTargetResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "supabaseUserId" VARCHAR(64) NOT NULL,
    "userId" TEXT,
    "calendarIdSnapshot" VARCHAR(255),
    "status" "app"."DeletionStatus" NOT NULL DEFAULT 'REQUESTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(64),
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calendarDeletedAt" TIMESTAMPTZ(3),
    "googleTokenRevokedAt" TIMESTAMPTZ(3),
    "userDataDeletedAt" TIMESTAMPTZ(3),
    "supabaseUserDeletedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."SyncLease" (
    "key" VARCHAR(191) NOT NULL,
    "ownerToken" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncLease_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "app"."YouTubeQuotaUsage" (
    "quotaDate" CHAR(10) NOT NULL,
    "bucket" "app"."YouTubeQuotaBucket" NOT NULL,
    "unitsUsed" INTEGER NOT NULL DEFAULT 0,
    "unitsReserved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "YouTubeQuotaUsage_pkey" PRIMARY KEY ("quotaDate","bucket")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_supabaseUserId_key" ON "app"."User"("supabaseUserId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "app"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCredential_userId_key" ON "app"."GoogleCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_userId_key" ON "app"."CalendarConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarConnection_googleCalendarId_key" ON "app"."CalendarConnection"("googleCalendarId");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeChannel_youtubeChannelId_key" ON "app"."YouTubeChannel"("youtubeChannelId");

-- CreateIndex
CREATE INDEX "YouTubeChannel_handle_idx" ON "app"."YouTubeChannel"("handle");

-- CreateIndex
CREATE INDEX "YouTubeChannel_lastFetchedAt_idx" ON "app"."YouTubeChannel"("lastFetchedAt");

-- CreateIndex
CREATE INDEX "YouTubeChannel_lastFetchStatus_nextFetchAt_idx" ON "app"."YouTubeChannel"("lastFetchStatus", "nextFetchAt");

-- CreateIndex
CREATE INDEX "UserChannelSubscription_userId_status_idx" ON "app"."UserChannelSubscription"("userId", "status");

-- CreateIndex
CREATE INDEX "UserChannelSubscription_channelId_status_idx" ON "app"."UserChannelSubscription"("channelId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UserChannelSubscription_userId_channelId_key" ON "app"."UserChannelSubscription"("userId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledBroadcast_youtubeVideoId_key" ON "app"."ScheduledBroadcast"("youtubeVideoId");

-- CreateIndex
CREATE INDEX "ScheduledBroadcast_channelId_scheduledStartAt_idx" ON "app"."ScheduledBroadcast"("channelId", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "ScheduledBroadcast_status_scheduledStartAt_idx" ON "app"."ScheduledBroadcast"("status", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "CalendarEventMapping_googleCalendarEventId_idx" ON "app"."CalendarEventMapping"("googleCalendarEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEventMapping_userId_broadcastId_key" ON "app"."CalendarEventMapping"("userId", "broadcastId");

-- CreateIndex
CREATE INDEX "SyncRun_type_status_startedAt_idx" ON "app"."SyncRun"("type", "status", "startedAt");

-- CreateIndex
CREATE INDEX "SyncRun_status_queuedAt_idx" ON "app"."SyncRun"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "SyncTargetResult_targetType_targetId_startedAt_idx" ON "app"."SyncTargetResult"("targetType", "targetId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncTargetResult_syncRunId_targetType_targetId_key" ON "app"."SyncTargetResult"("syncRunId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRequest_supabaseUserId_key" ON "app"."AccountDeletionRequest"("supabaseUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRequest_userId_key" ON "app"."AccountDeletionRequest"("userId");

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_status_requestedAt_idx" ON "app"."AccountDeletionRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "SyncLease_expiresAt_idx" ON "app"."SyncLease"("expiresAt");

-- CreateIndex
CREATE INDEX "YouTubeQuotaUsage_updatedAt_idx" ON "app"."YouTubeQuotaUsage"("updatedAt");

-- AddForeignKey
ALTER TABLE "app"."GoogleCredential" ADD CONSTRAINT "GoogleCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."UserChannelSubscription" ADD CONSTRAINT "UserChannelSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."UserChannelSubscription" ADD CONSTRAINT "UserChannelSubscription_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "app"."YouTubeChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."ScheduledBroadcast" ADD CONSTRAINT "ScheduledBroadcast_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "app"."YouTubeChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."CalendarEventMapping" ADD CONSTRAINT "CalendarEventMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."CalendarEventMapping" ADD CONSTRAINT "CalendarEventMapping_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "app"."ScheduledBroadcast"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."SyncRun" ADD CONSTRAINT "SyncRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "app"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."SyncTargetResult" ADD CONSTRAINT "SyncTargetResult_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "app"."SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
