# YouTube API Data retention: production rollout gate

This is an implementation and operations checklist, not a record of deployment. Production changes need separate human approval for the database migration, AWS/API/worker release, and web release. Do not tell the YouTube review team the remediation is live before all gates below pass.

## Before release

1. Review the complete diff and CI for the exact release commit. Confirm that the migration adds `metadataFetchedAt`, `metadataAttemptedAt`, `apiFetchedAt`, `channelReregistrationRequired`, and `CalendarCleanupTask`; it does not backfill NULL timestamps to now.
2. Inventory production rows by age without printing IDs or titles. For channels use `COALESCE("metadataFetchedAt", "createdAt")`; for broadcasts use `COALESCE("apiFetchedAt", "createdAt")`. Count rows older than 18, 22, 27, and 30 calendar days; count NULL timestamps separately. Count orphan `CalendarEventMapping` rows (no matching user subscription), managed past events, and reauth-required users. Record only aggregate counts.
3. Ensure a successful current backup/manifest pair and a rollback plan. Verify the S3 backup bucket is non-versioned and has 7-day Lifecycle. The dump contains YouTube API Data; Lifecycle does not guarantee an exact physical deletion instant.
4. Confirm YouTube quota headroom and Google Calendar authorization. If legacy rows already exceed 30 days, prioritize purging over refresh/quota conservation. Schedule a maintenance window and pause the old worker before switching code. Do not run old code against the new schema as an open-ended steady state.

## Separately approved release sequence

1. Apply `migrate-production.yml` for the exact commit with required reviewer approval. Verify `prisma migrate status`, migration attestation, and new table/columns. A migration PASS does not authorize the next write.
2. Deploy API and worker with `deploy-production.yml`, using that commit's successful migration run ID and a separate production-infra approval. Inspect the CDK diff for unrelated replacement/deletion before approval. The worker's first run atomically records the owner, Calendar ID, and event ID in `CalendarCleanupTask` and removes expired mappings; it then purges their expired YouTube rows, even if Calendar deletion cannot yet be verified. Calendar deletion retries use only the task and process up to 100 targets per run. Failed or inaccessible events retain tasks for later verification; never count them as deleted. Metadata refresh then considers at most 20 still-valid channels. Existing NULL fetch timestamps use `createdAt`, never deployment time.
3. Run and observe scheduled retention cycles under controlled load. A failed YouTube refresh does not extend the stored timestamp; at 22 days the channel ID and API Data are removed and re-registration becomes necessary. Re-run until all expired rows are gone, checking quota and Calendar cleanup failures after each run. OAuth-revoked users are not retried for Calendar deletion until reauthorization; users may need to delete remaining events themselves.
4. Publish the web build for the same commit after API/worker verification. Confirm the re-registration warning, Terms, and Privacy pages at `https://oshi-schedule.com/terms` and `https://oshi-schedule.com/privacy`.

## Post-release evidence

- Query aggregate YouTube channel/broadcast age counts again: >22 days and >=30 days must be zero, including NULL timestamp fallback. Verify old `youtubeChannelId` values are not used in search/sync after deletion. Do not log IDs in evidence.
- Confirm `CalendarCleanupTask` pending count and oldest age, Calendar event deletion for a controlled test user, orphan mapping count, and the revoked-credential case. Pending tasks are not proof that Calendar events have been deleted.
- Confirm worker's `scheduled_sync_completed` within six hours, `youtube_stale_data_audit` counts zero, Worker Errors/Throttles, SQS and Scheduler DLQs empty, channel refresh failure/stale/Calendar cleanup alarms and SNS subscription confirmed. Monitor through at least one full 18/22-day cycle; alarms alone are not a retention guarantee.
- Confirm `/ready`, login, channel registration, upcoming/live/completed event updates, Calendar sync and re-sync, account/channel removal, and production Terms/Privacy. Check new migration checksum and the backup manifest from a subsequent daily backup.

## Hard limitation and restore rule

The application purges at 22 days during normal worker/API activity, and its display/sync queries reject expired rows. Revoked Google OAuth leaves Calendar deletion tasks pending but does not block YouTube API Data purge. A total worker and API outage or an inaccessible database can still leave stored YouTube API Data beyond 30 days; alarms and S3 Lifecycle do not establish an unconditional physical deletion guarantee. Escalate any outage before the deadline and keep the application offline until retention has run and the aggregate age counts are zero. On a restore, use [the restore gate](supabase-backup-and-restore.md) before allowing production traffic; never promote a backup containing expired YouTube API Data merely because it was a valid backup.
