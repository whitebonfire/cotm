import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  build: {
    // The server serves this directory in production. Keep them in step.
    outDir: "../dist/public",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
