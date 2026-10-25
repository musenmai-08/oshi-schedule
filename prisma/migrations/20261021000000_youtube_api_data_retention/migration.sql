ALTER TABLE "app"."YouTubeChannel" ADD COLUMN "metadataFetchedAt" TIMESTAMPTZ(3);
ALTER TABLE "app"."YouTubeChannel" ADD COLUMN "metadataAttemptedAt" TIMESTAMPTZ(3);
ALTER TABLE "app"."ScheduledBroadcast" ADD COLUMN "apiFetchedAt" TIMESTAMPTZ(3);
ALTER TABLE "app"."User" ADD COLUMN "channelReregistrationRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "app"."CalendarCleanupTask" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "calendarId" VARCHAR(255) NOT NULL,
  "eventId" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarCleanupTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CalendarCleanupTask_userId_calendarId_eventId_key"
  ON "app"."CalendarCleanupTask"("userId", "calendarId", "eventId");
CREATE INDEX "CalendarCleanupTask_createdAt_idx" ON "app"."CalendarCleanupTask"("createdAt");
ALTER TABLE "app"."CalendarCleanupTask"
  ADD CONSTRAINT "CalendarCleanupTask_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "app"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
