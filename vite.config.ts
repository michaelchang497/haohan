import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 專案頁的網址在 /haohan/ 底下；本機開發維持 /
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.BASE_PATH ?? '/haohan/') : '/',
  plugins: [react()],
  server: { port: 5180 },
}));
