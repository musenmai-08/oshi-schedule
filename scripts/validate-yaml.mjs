import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parseDocument } from 'yaml';

const files = process.argv.slice(2).filter((argument) => argument !== '--');
if (files.length === 0) {
  console.error('Usage: node scripts/validate-yaml.mjs <file> [...]');
  process.exitCode = 2;
} else {
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const document = parseDocument(source, { prettyErrors: true, strict: true });
    if (document.errors.length > 0) {
      for (const error of document.errors) console.error(`${file}: ${error.message}`);
      process.exitCode = 1;
      continue;
    }
    const value = document.toJS();
    if (file.endsWith('openapi.yaml') && (!value?.openapi || !value?.paths)) {
      console.error(`${file}: OpenAPI document must define openapi and paths`);
      process.exitCode = 1;
      continue;
    }
    if (file.includes('/workflows/') && (!value?.jobs || !value?.on)) {
      console.error(`${file}: workflow must define on and jobs`);
      process.exitCode = 1;
    }
  }
}
