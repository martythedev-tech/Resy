import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://localhost:5000'
  const devPort = Number(env.VITE_DEV_PORT) || 3000
  const appVersion = env.VITE_APP_VERSION || pkg.version
  const releaseChannel = env.VITE_RELEASE_CHANNEL || (mode === 'production' ? 'release' : 'dev')
  const buildId = env.VITE_BUILD_ID
    || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
    || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_ID__: JSON.stringify(buildId),
      __RELEASE_CHANNEL__: JSON.stringify(releaseChannel),
    },
    server: {
      port: devPort,
      open: false,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/uploads': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
