import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Evita baixar modelo transformers no hot embed do remember; testes que
    // precisam de vetor injetam FakeEmbedder (bypassa ARGUS_HOT_EMBED=0).
    env: {
      ARGUS_HOT_EMBED: "0",
    },
  },
});
