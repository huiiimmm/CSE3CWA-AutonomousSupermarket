import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, // Runs your frontend here
    proxy: {
      // Directs frontend /api calls to your Express proxy/backend server
      '/api': {
        target: 'http://127.0.0.1:4000', // Set to 3000 if using your proxy, or>
        changeOrigin: true, 
      },
    },
  },
});
