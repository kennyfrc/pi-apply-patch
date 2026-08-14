import { defineConfig } from "vitest/config";

// Internal pi packages ship TypeScript source (pi loads .ts directly). Vitest
// externalizes node_modules by default, which would serve raw .ts to Node.
// Inline them so the transform pipeline handles them.
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/^pi-portable-ui$/],
      },
    },
  },
});
