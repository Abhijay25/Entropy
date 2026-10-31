import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const apiHost = env.API_HOST || '127.0.0.1';
  const apiPort = env.API_PORT || '3001';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': `http://${apiHost}:${apiPort}`
      }
    }
  };
});
