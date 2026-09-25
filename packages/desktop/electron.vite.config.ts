import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// Everything lives in devDependencies so electron-vite bundles it (including the
// TS-source @kando/protocol) instead of externalizing it into a runtime require.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Task images arrive from core as blob: URLs; nothing is ever loaded from the web.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  'connect-src ws://127.0.0.1:*'
].join('; ')

// Build-only: the dev server injects an inline React Refresh preamble a strict CSP would block.
function productionCsp(): Plugin {
  return {
    name: 'kando-production-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), productionCsp()]
  }
})
