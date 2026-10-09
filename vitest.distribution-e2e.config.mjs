import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
export default (() => {
  const uRL = new URL('./src', import.meta.url);
  const fileURLToPathResult = fileURLToPath(uRL);
  const uRL2 = new URL('./tests', import.meta.url);
  const fileURLToPathResult2 = fileURLToPath(uRL2);
  const options = {
    '@': fileURLToPathResult,
    '@tests': fileURLToPathResult2,
  };
  const options2 = {
    alias: options,
  };
  const options3 = {
    include: ['tests/e2e/**/*.manual.ts'],
    environment: 'node',
    testTimeout: 180000,
    hookTimeout: 180000,
  };
  const defineConfigOptions = {
    resolve: options2,
    test: options3,
  };
  return defineConfig(defineConfigOptions);
})();
