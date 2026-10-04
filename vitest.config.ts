import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node'
  }
})
