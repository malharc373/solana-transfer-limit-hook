import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ command, mode }) => ({
  base: "./", // works from any path, such as a project page
  plugins: [react()],
  // The generated client reads process.env["NODE_ENV"], which the dev server leaves as is.
  define: command === "serve" && !process.env.VITEST ? { "process.env": JSON.stringify({ NODE_ENV: mode }) } : {},
  test: { include: ["test/**/*.test.ts"], fileParallelism: false },
}));
