import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import Icons from 'unplugin-icons/vite'
import { nitro } from 'nitro/vite'
import { fileURLToPath } from 'node:url'

try { process.loadEnvFile(new URL('../../.env', import.meta.url)) } catch { /* Docker supplies environment variables. */ }

export default defineConfig({
  envDir: '../../',
  server: { port: 3000 },
  ssr: { external: ['better-sqlite3'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tailwindcss(), tanstackStart(), nitro(), viteReact(), Icons({ compiler: 'jsx', jsx: 'react' })],
})
