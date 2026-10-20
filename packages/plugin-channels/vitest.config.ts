import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tsx sources use the react-jsx (automatic) transform; vitest's esbuild
  // defaults to classic and would emit `React.createElement` without an import
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // host tests run under node (the Telegram adapter, the fake Bot API and
    // the router all drive real sockets/timers — testTimeout stays at 20s);
    // client tests (tsx + DOM) get jsdom
    environmentMatchGlobs: [['tests/client/**', 'jsdom']],
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
  },
})
