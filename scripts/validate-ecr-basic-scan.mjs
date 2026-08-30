import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const severityOrder = new Set(['CRITICAL', 'HIGH']);

const getAttribute = (finding, key) =>
  finding.attributes?.find((attribute) => attribute.key === key)?.value ?? 'unknown';

const allowedIds = new Set(
  (await readFile('.trivyignore', 'utf8'))
    .split(/\r?\n/)
    .map((line) => /^(CVE-\d{4}-\d{4,})\s+exp:\d{4}-\d{2}-\d{2}$/.exec(line.trim())?.[1])
    .filter(Boolean),
);

const readFindings = async () => {
  const fixtureIndex = process.argv.indexOf('--findings');
  if (fixtureIndex >= 0) {
    const fixture = process.argv[fixtureIndex + 1];
    if (!fixture || process.argv.length !== fixtureIndex + 2) {
      throw new Error('Usage: validate-ecr-basic-scan.mjs [--findings fixture.json]');
    }
    const response = JSON.parse(await readFile(fixture, 'utf8'));
    return {
      imageScanStatus: response.imageScanStatus,
      findings: response.imageScanFindings?.findings ?? [],
    };
  }

  const repository = process.env.STAGING_ECR_REPOSITORY;
  const digest = process.env.IMAGE_DIGEST;
  const region = process.env.AWS_REGION;
  if (!repository || !digest || !region) {
    throw new Error('AWS_REGION, STAGING_ECR_REPOSITORY, and IMAGE_DIGEST are required');
  }

  const findings = [];
  let imageScanStatus;
  let nextToken;
  do {
    const args = [
      'ecr',
      'describe-image-scan-findings',
      '--region',
      region,
      '--repository-name',
      repository,
      '--image-id',
      `imageDigest=${digest}`,
      '--output',
      'json',
    ];
    if (nextToken) args.push('--next-token', nextToken);
    const { stdout } = await execFile('aws', args);
    const response = JSON.parse(stdout);
    imageScanStatus ??= response.imageScanStatus;
    findings.push(...(response.imageScanFindings?.findings ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return { imageScanStatus, findings };
};

try {
  const scan = await readFindings();
  if (scan.imageScanStatus?.status !== 'COMPLETE') {
    throw new Error(`ECR Basic Scan must be COMPLETE, got ${scan.imageScanStatus?.status ?? 'unknown'}`);
  }

  const rejected = (scan.findings ?? []).filter(
    (finding) => severityOrder.has(finding.severity) && !allowedIds.has(finding.name),
  );
  if (rejected.length > 0) {
    for (const finding of rejected) {
      console.error(
        `Unapproved ECR ${finding.severity}: ${finding.name} package=${getAttribute(finding, 'package_name')} version=${getAttribute(finding, 'package_version')}`,
      );
    }
    process.exit(1);
  }

  console.log('ECR Basic Scan production policy passed: no unapproved CRITICAL/HIGH findings');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to validate ECR Basic Scan');
  process.exit(1);
}
