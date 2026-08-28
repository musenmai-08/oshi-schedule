import { readFile } from 'node:fs/promises';
import process from 'node:process';

const productionIgnoreFile = '.trivyignore';
const stagingIgnoreFile = '.trivyignore.staging';
const approvedStagingOnlyEntries = new Map([
  ['CVE-2026-54874', '2026-09-11'],
  ['CVE-2026-63072', '2026-09-11'],
  ['CVE-2026-63076', '2026-09-11'],
]);

const parseEntries = (source) =>
  new Map(
    source
      .split(/\r?\n/)
      .map((line) => /^(CVE-\d{4}-\d{4,})\s+exp:(\d{4}-\d{2}-\d{2})$/.exec(line.trim()))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );

const [productionSource, stagingSource, ciWorkflow, stagingWorkflow, productionWorkflow] =
  await Promise.all([
    readFile(productionIgnoreFile, 'utf8'),
    readFile(stagingIgnoreFile, 'utf8'),
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('.github/workflows/deploy-staging.yml', 'utf8'),
    readFile('.github/workflows/deploy-production.yml', 'utf8'),
  ]);

const productionEntries = parseEntries(productionSource);
const stagingEntries = parseEntries(stagingSource);
const errors = [];

for (const [id, expiration] of productionEntries) {
  if (stagingEntries.get(id) !== expiration) {
    errors.push(`${stagingIgnoreFile} must contain production entry ${id} with exp:${expiration}`);
  }
}

const stagingOnlyEntries = new Map(
  [...stagingEntries].filter(([id]) => !productionEntries.has(id)),
);

for (const [id, expiration] of approvedStagingOnlyEntries) {
  if (stagingOnlyEntries.get(id) !== expiration) {
    errors.push(`${stagingIgnoreFile} must contain staging-only ${id} with exp:${expiration}`);
  }
}

for (const id of stagingOnlyEntries.keys()) {
  if (!approvedStagingOnlyEntries.has(id)) {
    errors.push(`${stagingIgnoreFile} contains unapproved staging-only exception ${id}`);
  }
}

if (
  productionSource.includes('CVE-2026-54874') ||
  productionSource.includes('CVE-2026-63072') ||
  productionSource.includes('CVE-2026-63076')
) {
  errors.push(`${productionIgnoreFile} must not contain the staging-only OpenSSL exceptions`);
}

if (!stagingWorkflow.includes('trivyignores: .trivyignore.staging')) {
  errors.push('deploy-staging.yml must scan with .trivyignore.staging');
}

for (const [name, workflow] of [
  ['ci.yml', ciWorkflow],
  ['deploy-production.yml', productionWorkflow],
]) {
  if (!workflow.includes('trivyignores: .trivyignore')) {
    errors.push(`${name} must scan with the production .trivyignore policy`);
  }
  if (workflow.includes('.trivyignore.staging')) {
    errors.push(`${name} must not reference .trivyignore.staging`);
  }
}

for (const id of approvedStagingOnlyEntries.keys()) {
  if (!productionWorkflow.includes(`name=='${id}'`)) {
    errors.push(`deploy-production.yml must reject staging ECR finding ${id}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(
  `Trivy policy isolation valid: ${productionEntries.size} production exceptions, ${stagingOnlyEntries.size} additional staging-only exceptions`,
);
