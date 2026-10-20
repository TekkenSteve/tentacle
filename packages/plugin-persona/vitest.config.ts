import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tsx sources use the react-jsx (automatic) transform; vitest's esbuild
  // defaults to classic and would emit `React.createElement` without an import
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
