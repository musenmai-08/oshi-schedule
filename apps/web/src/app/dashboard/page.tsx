import { AppShell } from '@/components/app-shell';
import { Dashboard } from '@/components/dashboard';
import { parseSetupRecovery } from '@/lib/google-connection';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string | string[] }>;
}) {
  const setupValue = (await searchParams).setup;
  return (
    <AppShell>
      <Dashboard
        initialSetup={parseSetupRecovery(setupValue)}
        clearSetupQuery={setupValue !== undefined}
      />
    </AppShell>
  );
}
