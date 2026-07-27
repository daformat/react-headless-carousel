import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".playground",
  server: { port: 5199 },
  plugins: [react()],
});
