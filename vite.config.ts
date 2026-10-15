import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const hasSupabaseConfig = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY)

  return {
    plugins: [
      react(),
      {
        // Dev-server only. Without a Supabase project the app fails closed by design, so
        // the root URL would be a dead end; send it to the sample-data Home tab preview.
        name: 'nooki-home-preview-fallback',
        apply: 'serve',
        configureServer(server) {
          if (hasSupabaseConfig) return
          server.middlewares.use((request, response, next) => {
            if (request.url === '/' || request.url === '/index.html') {
              response.writeHead(302, { Location: '/preview.html' })
              response.end()
              return
            }
            next()
          })
        },
      },
    ],
    server: {
      host: '0.0.0.0',
      port: 5173,
      // Never drift to 5174: the preview URL is pinned to this port.
      strictPort: true,
      allowedHosts: true,
    },
  }
})
