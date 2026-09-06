import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';

// Prisma accepts connection hints that libpq rejects. Keep libpq options such
// as sslmode intact while removing only Prisma/client-specific parameters.
export const toLibpqUrl = (value) => {
  const url = new URL(value);
  for (const parameter of [
    'schema',
    'pgbouncer',
    'connection_limit',
    'pool_timeout',
    'connect_timeout',
  ]) {
    url.searchParams.delete(parameter);
  }
  return url.toString();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = process.env.PRISMA_DATABASE_URL;
  if (!value) throw new Error('PRISMA_DATABASE_URL is required');
  process.stdout.write(toLibpqUrl(value));
}
