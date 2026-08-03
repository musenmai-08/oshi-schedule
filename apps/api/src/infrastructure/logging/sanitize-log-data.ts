const REDACTED = '[REDACTED]';

const secretFieldNames = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'code',
  'databaseurl',
  'encryptedrefreshtoken',
  'encryptionkey',
  'idtoken',
  'provideraccesstoken',
  'providerrefreshtoken',
  'refreshtoken',
  'servicerolekey',
  'supabaseservicerolekey',
  'token',
  'tokenencryptionkeys',
]);

const sensitiveQueryNames = [
  'access_token',
  'authorization',
  'client_secret',
  'code',
  'id_token',
  'provider_access_token',
  'provider_refresh_token',
  'refresh_token',
  'token',
];

const sensitiveQueryPattern = new RegExp(
  `([?&#](?:${sensitiveQueryNames.join('|')})=)[^&#\\s]*`,
  'gi',
);
const bearerPattern = /\bBearer\s+[^\s,;]+/gi;

const normalizeFieldName = (name: string) => name.replace(/[^a-z0-9]/gi, '').toLowerCase();

export function sanitizeLogText(value: string) {
  return value
    .replace(sensitiveQueryPattern, `$1${REDACTED}`)
    .replace(bearerPattern, `Bearer ${REDACTED}`);
}

function sanitizeLogValueInternal(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return sanitizeLogText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date || value instanceof RegExp || Buffer.isBuffer(value)) return value;
  if (value instanceof URL) return sanitizeLogText(value.toString());
  if (value instanceof Error) {
    const sanitized = new Error(sanitizeLogText(value.message));
    sanitized.name = value.name;
    if (value.stack) sanitized.stack = sanitizeLogText(value.stack);
    return sanitized;
  }
  const known = seen.get(value);
  if (known) return known;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    output.push(...value.map((item) => sanitizeLogValueInternal(item, seen)));
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value))
    output[key] = secretFieldNames.has(normalizeFieldName(key))
      ? REDACTED
      : sanitizeLogValueInternal(item, seen);
  return output;
}

export function sanitizeLogValue(value: unknown) {
  return sanitizeLogValueInternal(value, new WeakMap());
}

export function sanitizeLogArguments(values: unknown[]) {
  return values.map((value) => sanitizeLogValue(value));
}
