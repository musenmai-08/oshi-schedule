export const DEFAULT_WAKE_HOURS = 4;
export const MAX_WAKE_HOURS = 24;
export const UNSET_WAKE_DEADLINE = 'UNSET';

const invalidHours = () => new Error(`--hours must be an integer between 1 and ${MAX_WAKE_HOURS}`);

export const parseWakeHours = (args = []) => {
  if (args.length === 0) return DEFAULT_WAKE_HOURS;
  if (args.length !== 2 || args[0] !== '--hours' || !/^[0-9]+$/.test(args[1])) {
    throw invalidHours();
  }
  const hours = Number(args[1]);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_WAKE_HOURS) {
    throw invalidHours();
  }
  return hours;
};

export const calculateWakeDeadline = (hours, now = new Date()) => {
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_WAKE_HOURS) {
    throw invalidHours();
  }
  const timestamp = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new Error('Current time is invalid');
  return new Date(timestamp + hours * 60 * 60 * 1000).toISOString();
};

export const inspectWakeDeadline = (value, now = new Date()) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === '' || normalized === UNSET_WAKE_DEADLINE) return { state: 'UNSET' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized)) {
    return { state: 'INVALID' };
  }
  const expiresAt = new Date(normalized);
  const nowTimestamp = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(nowTimestamp)) {
    return { state: 'INVALID' };
  }
  return {
    state: expiresAt.getTime() <= nowTimestamp ? 'EXPIRED' : 'ACTIVE',
    expiresAt: expiresAt.toISOString(),
    remainingMs: Math.max(0, expiresAt.getTime() - nowTimestamp),
  };
};

const jstParts = (date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );

export const formatDeadlineJst = (expiresAt) => {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Deadline is invalid');
  const parts = jstParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} JST`;
};

export const formatRemaining = (remainingMs) => {
  const totalMinutes = Math.max(0, Math.ceil(remainingMs / 60_000));
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};
