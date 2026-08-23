import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import aitDevtools from "@apps-in-toss/devtools/unplugin";

// https://vite.dev/config/
export default defineConfig({
  base: '/brainspeed-plus/',
  plugins: [aitDevtools.vite(), react()],
})
