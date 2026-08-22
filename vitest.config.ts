import path from "node:path";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig.json's "@/*" -> "./*" path alias so route/lib tests can
// import with the same "@/..." paths the app code uses, without pulling in
// an extra plugin dependency for a single alias.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
  },
});
