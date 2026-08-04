import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3002',
      '/uploads': 'http://localhost:3002',
      '/lessons': 'http://localhost:3002',
      '/health': 'http://localhost:3002'
    }
  }
});
