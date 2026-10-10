import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { reportConfiguration } from './scripts/testing/report-configuration.js';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
    },
  },
  test: {
    ...reportConfiguration(),
    include: ['tests/e2e/**/*.manual.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
