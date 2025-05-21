<<<<<<< HEAD
// vite.config.js
import { defineConfig } from "vite";
=======
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
>>>>>>> parent of 79141c9 (Update vite.config.js)
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "./client", // 👈 base directory
  build: {
    outDir: "../dist/client", // 👈 where Render looks
    emptyOutDir: true,
  },
});


