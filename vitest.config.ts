/**
 * Scope vitest to svc-temporal's own source. Without these excludes the
 * runner picks up:
 *  - dist/**       compiled output (runs every test twice)
 *  - tne-plugins/** the vendored submodule's own test suites (unrelated +
 *                  fail when run outside their project root)
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'tne-plugins/**'],
  },
});
