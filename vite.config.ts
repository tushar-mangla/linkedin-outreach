import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import fs from 'node:fs'
import path from 'node:path'

function resolveBackendPort(): number {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.server-port'), 'utf-8').trim()
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  } catch {
    // No .server-port file yet; fall through to PORT / default.
  }
  const envPort = Number(process.env.PORT)
  if (Number.isInteger(envPort) && envPort > 0) return envPort
  return 3000
}

const backendPort = resolveBackendPort()
const backendTarget = `http://localhost:${backendPort}`

export default defineConfig({
  plugins: [tsconfigPaths()],
  server: {
    proxy: {
      '/api': backendTarget,
      '/health': backendTarget,
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
