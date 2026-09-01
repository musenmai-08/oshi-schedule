-- Prisma @updatedAt is maintained by the client and does not define a database default.
ALTER TABLE `YouTubeQuotaUsage`
  ALTER COLUMN `updatedAt` DROP DEFAULT;
