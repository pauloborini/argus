import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FILE_COUNT,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  shouldIgnore,
} from "../src/discovery/ignores.js";

describe("discovery ignores", () => {
  it("expõe limites padrão de segurança", () => {
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(2 * 1024 * 1024);
    expect(DEFAULT_MAX_FILE_COUNT).toBe(50_000);
  });

  it("ignora diretórios padrão", () => {
    expect(shouldIgnore("node_modules/react/index.js")).toBe(true);
    expect(shouldIgnore(".git/objects/ab/cd")).toBe(true);
    expect(shouldIgnore(".argus/file-manifest.json")).toBe(true);
    expect(shouldIgnore("dist/app.js")).toBe(true);
  });

  it("ignora sufixos padrão gerados", () => {
    expect(shouldIgnore("web/app.min.js")).toBe(true);
    expect(shouldIgnore("web/app.js.map")).toBe(true);
  });

  it("mantém arquivos de código elegíveis", () => {
    expect(shouldIgnore("src/main.ts")).toBe(false);
    expect(shouldIgnore("README.md")).toBe(false);
  });
});
