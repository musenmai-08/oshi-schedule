import { Prisma, PrismaClient } from '@prisma/client';

const runWhere: Prisma.SyncRunWhereInput = {
  type: { in: ['INITIAL', 'MANUAL'] },
};

const runSelect = Prisma.validator<Prisma.SyncRunSelect>()({
  id: true,
  status: true,
  type: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  errorCode: true,
});

export interface SyncRunStateCandidate {
  id: string;
  status: string;
  trigger: 'INITIAL' | 'MANUAL';
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
}

export interface SyncRunStateInspection {
  level: 'info';
  event: 'sync_run_state_inspection';
  mode: 'READ_ONLY';
  runCount: number;
  runs: SyncRunStateCandidate[];
  runsTruncated: boolean;
}

type SyncRunReader = Pick<PrismaClient['syncRun'], 'count' | 'findMany'>;
type RunRow = Prisma.SyncRunGetPayload<{ select: typeof runSelect }>;

const safeErrorCode = (errorCode: string | null): string | null =>
  errorCode && /^[A-Z][A-Z0-9_]{1,79}$/.test(errorCode)
    ? errorCode
    : errorCode
      ? 'UNCLASSIFIED_ERROR'
      : null;

const toCandidate = (row: RunRow): SyncRunStateCandidate => {
  if (row.type !== 'INITIAL' && row.type !== 'MANUAL')
    throw new Error('SyncRun state inspection returned an unsafe row');
  return {
    id: row.id,
    status: row.status,
    trigger: row.type,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    errorCode: safeErrorCode(row.errorCode),
  };
};

export async function inspectInitialManualSyncRuns(
  syncRuns: SyncRunReader,
): Promise<SyncRunStateInspection> {
  const [runCount, rows] = await Promise.all([
    syncRuns.count({ where: runWhere }),
    syncRuns.findMany({
      where: runWhere,
      orderBy: { queuedAt: 'desc' },
      take: 100,
      select: runSelect,
    }),
  ]);
  return {
    level: 'info',
    event: 'sync_run_state_inspection',
    mode: 'READ_ONLY',
    runCount,
    runs: rows.map(toCandidate),
    runsTruncated: runCount > rows.length,
  };
}

export async function inspectInitialManualSyncRunsWithPrisma(): Promise<SyncRunStateInspection> {
  const prisma = new PrismaClient();
  try {
    return await inspectInitialManualSyncRuns(prisma.syncRun);
  } finally {
    await prisma.$disconnect();
  }
}
