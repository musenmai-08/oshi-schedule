const LOCAL_WEB_ORIGIN = 'http://localhost:3001';

export function resolveWebOrigin(source: NodeJS.ProcessEnv = process.env) {
  const configured = source.WEB_ORIGIN?.trim();
  if (!configured) {
    if (source.NODE_ENV === 'production') throw new Error('WEB_ORIGIN is required in production');
    return LOCAL_WEB_ORIGIN;
  }

  const url = new URL(configured);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('WEB_ORIGIN must be an HTTP(S) origin without credentials, path, or query');
  if (source.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('WEB_ORIGIN must use HTTPS in production');
  return url.origin;
}
