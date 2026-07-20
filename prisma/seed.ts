import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.APP_MODE !== 'fake') return;
  await prisma.user.upsert({
    where: { supabaseUserId: 'demo-user' },
    update: {},
    create: {
      supabaseUserId: 'demo-user',
      email: 'developer@example.com',
      onboardingCompletedAt: new Date(),
      calendar: { create: { googleCalendarId: 'fake-calendar-demo', status: 'ACTIVE' } },
    },
  });
}

main().finally(async () => prisma.$disconnect());
