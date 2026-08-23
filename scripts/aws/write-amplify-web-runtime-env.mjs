import console from 'node:console';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

export const amplifyWebRuntimeEnvPath = 'apps/web/.env.production';

const resolveWebOrigin = (source) => {
  const configured = source.WEB_ORIGIN?.trim();
  if (!configured) throw new Error('WEB_ORIGIN is required');

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('WEB_ORIGIN must be a valid HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('WEB_ORIGIN must be an HTTPS origin without credentials, path, or query');

  return url.origin;
};

export async function writeAmplifyWebRuntimeEnv({
  workspaceRoot = process.cwd(),
  environment = process.env,
} = {}) {
  const webOrigin = resolveWebOrigin(environment);
  const destination = path.join(workspaceRoot, amplifyWebRuntimeEnvPath);

  await writeFile(destination, `WEB_ORIGIN=${JSON.stringify(webOrigin)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return destination;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const destination = await writeAmplifyWebRuntimeEnv();
    console.log(`Generated ${path.relative(process.cwd(), destination)} with WEB_ORIGIN only`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to generate web runtime env');
    process.exitCode = 1;
  }
}
