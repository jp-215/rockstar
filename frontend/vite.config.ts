import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  server: { port: 5173, fs: { allow: ['..'] } },   // '..' so ../shared can be imported
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tv: resolve(__dirname, 'tv.html'),
        comms: resolve(__dirname, 'comms.html'),
      },
    },
  },
});
