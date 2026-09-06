import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@oshi-schedule/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@oshi-schedule/api/runtime': fileURLToPath(
        new URL('../api/src/runtime.ts', import.meta.url),
      ),
      '@oshi-schedule/api/lambda-env': fileURLToPath(
        new URL('../api/src/infrastructure/lambda/runtime-env.ts', import.meta.url),
      ),
    },
  },
});
