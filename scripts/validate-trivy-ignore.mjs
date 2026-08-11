import { readFile } from 'node:fs/promises';
import process from 'node:process';

const args = process.argv.slice(2);
let file = '.trivyignore';
let evaluationDate = new Date().toISOString().slice(0, 10);
let fileWasSet = false;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--date') {
    evaluationDate = args[index + 1] ?? '';
    index += 1;
  } else if (argument.startsWith('--date=')) {
    evaluationDate = argument.slice('--date='.length);
  } else if (!fileWasSet) {
    file = argument;
    fileWasSet = true;
  } else {
    console.error(`Unexpected argument: ${argument}`);
    process.exit(2);
  }
}

const isCalendarDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

if (!isCalendarDate(evaluationDate)) {
  console.error(`Invalid evaluation date: ${evaluationDate || '(empty)'}`);
  process.exit(2);
}

const source = await readFile(file, 'utf8');
const entries = [];
const errors = [];
const seen = new Set();

for (const [offset, rawLine] of source.split(/\r?\n/).entries()) {
  const lineNumber = offset + 1;
  const line = rawLine.trim();
  if (line === '' || line.startsWith('#')) continue;

  const match = /^(CVE-\d{4}-\d{4,})\s+exp:(\d{4}-\d{2}-\d{2})$/.exec(line);
  if (!match) {
    errors.push(
      `${file}:${lineNumber}: expected "CVE-YYYY-NNNN exp:YYYY-MM-DD" with no extra fields`,
    );
    continue;
  }

  const [, id, expiration] = match;
  if (seen.has(id)) errors.push(`${file}:${lineNumber}: duplicate exception ${id}`);
  seen.add(id);

  if (!isCalendarDate(expiration)) {
    errors.push(`${file}:${lineNumber}: invalid expiration date ${expiration}`);
  } else if (expiration <= evaluationDate) {
    errors.push(
      `${file}:${lineNumber}: ${id} expired on ${expiration} (evaluation date ${evaluationDate})`,
    );
  }

  entries.push({ id, expiration });
}

if (entries.length === 0) errors.push(`${file}: no CVE exceptions found`);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

const earliestExpiration = entries
  .map(({ expiration }) => expiration)
  .sort((left, right) => left.localeCompare(right))[0];

console.log(
  `${file}: ${entries.length} expiring CVE exceptions valid on ${evaluationDate}; earliest expiration ${earliestExpiration}`,
);
