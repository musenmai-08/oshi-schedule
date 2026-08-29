import { Prisma, PrismaClient } from '@prisma/client';

const queuedRunWhere: Prisma.SyncRunWhereInput = {
  status: 'QUEUED',
  type: { in: ['INITIAL', 'MANUAL'] },
};

const candidateSelect = Prisma.validator<Prisma.SyncRunSelect>()({
  id: true,
  status: true,
  type: true,
  queuedAt: true,
});

export interface QueuedSyncRunCandidate {
  id: string;
  status: 'QUEUED';
  trigger: 'INITIAL' | 'MANUAL';
  queuedAt: string;
}

export interface QueuedSyncRunInspection {
  level: 'info';
  event: 'queued_sync_run_inspection';
  mode: 'READ_ONLY';
  selection: 'NONE' | 'EXACTLY_ONE' | 'MULTIPLE';
  candidateCount: number;
  candidates: QueuedSyncRunCandidate[];
  candidatesTruncated: boolean;
}

type SyncRunReader = Pick<PrismaClient['syncRun'], 'count' | 'findMany'>;
type CandidateRow = Prisma.SyncRunGetPayload<{ select: typeof candidateSelect }>;

const toCandidate = (row: CandidateRow): QueuedSyncRunCandidate => {
  if (row.status !== 'QUEUED' || (row.type !== 'INITIAL' && row.type !== 'MANUAL'))
    throw new Error('Queued SyncRun inspection returned an unsafe row');
  return {
    id: row.id,
    status: row.status,
    trigger: row.type,
    queuedAt: row.queuedAt.toISOString(),
  };
};

export async function inspectQueuedSyncRuns(
  syncRuns: SyncRunReader,
): Promise<QueuedSyncRunInspection> {
  const [candidateCount, rows] = await Promise.all([
    syncRuns.count({ where: queuedRunWhere }),
    syncRuns.findMany({
      where: queuedRunWhere,
      orderBy: { queuedAt: 'asc' },
      take: 2,
      select: candidateSelect,
    }),
  ]);
  const candidates = rows.map(toCandidate);
  return {
    level: 'info',
    event: 'queued_sync_run_inspection',
    mode: 'READ_ONLY',
    selection: candidateCount === 0 ? 'NONE' : candidateCount === 1 ? 'EXACTLY_ONE' : 'MULTIPLE',
    candidateCount,
    candidates,
    candidatesTruncated: candidateCount > candidates.length,
  };
}

export async function inspectQueuedSyncRunsWithPrisma(): Promise<QueuedSyncRunInspection> {
  const prisma = new PrismaClient();
  try {
    return await inspectQueuedSyncRuns(prisma.syncRun);
  } finally {
    await prisma.$disconnect();
  }
}
