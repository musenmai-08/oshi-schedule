import console from 'node:console';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const productionIgnoreFile = '.trivyignore';
const stagingIgnoreFile = '.trivyignore.staging';
const approvedStagingOnlyTrivyEntries = new Map([
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

const [productionSource, stagingSource, ciWorkflow, productionWorkflow] =
  await Promise.all([
    readFile(productionIgnoreFile, 'utf8'),
    readFile(stagingIgnoreFile, 'utf8'),
    readFile('.github/workflows/ci.yml', 'utf8'),
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

for (const [id, expiration] of approvedStagingOnlyTrivyEntries) {
  if (stagingOnlyEntries.get(id) !== expiration) {
    errors.push(`${stagingIgnoreFile} must contain staging-only ${id} with exp:${expiration}`);
  }
}

for (const id of stagingOnlyEntries.keys()) {
  if (!approvedStagingOnlyTrivyEntries.has(id)) {
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

for (const [name, workflow] of [['ci.yml', ciWorkflow]]) {
  if (!workflow.includes('trivyignores: .trivyignore')) {
    errors.push(`${name} must scan with the production .trivyignore policy`);
  }
  if (workflow.includes('.trivyignore.staging')) {
    errors.push(`${name} must not reference .trivyignore.staging`);
  }
  if (!workflow.includes("cache: 'false'")) {
    errors.push(`${name} must disable the Trivy Action cache so each production gate uses a fresh vulnerability database`);
  }
}

if (!productionWorkflow.includes('uses: ./.github/workflows/ci.yml')) {
  errors.push('deploy-production.yml must use the CI workflow, including the production Trivy gate');
}
if (!productionWorkflow.includes('needs: ci')) {
  errors.push('deploy-production.yml must wait for the CI production Trivy gate');
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(
  `Trivy policy isolation valid: ${productionEntries.size} production exceptions and ${stagingOnlyEntries.size} additional staging-only Trivy exceptions`,
);
