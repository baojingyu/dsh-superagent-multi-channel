import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
// Fake-timer panel specs do real async work; the 5s default is too tight on a loaded box and a
// timeout leaks pending timers into later specs in the same file. Give every hook and test room.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'], testTimeout: 30000, hookTimeout: 30000 } })
