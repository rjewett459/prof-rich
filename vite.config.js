import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "./client",                      // 👈 tells Vite where to start
  build: {
    outDir: "../dist/client",            // 👈 output goes where Express expects
    emptyOutDir: true,
  },
});

