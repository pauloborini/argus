import { describe, expect, it } from "vitest";
import { detectLanguageFromPath, SUPPORTED_LANGUAGES } from "../src/extraction/language.js";

describe("language detection", () => {
  it("mapeia extensões core e extensão imediata", () => {
    expect(detectLanguageFromPath("src/app.ts")).toEqual({
      status: "supported",
      language: "typescript",
      coverage_level: "full",
    });
    expect(detectLanguageFromPath("lib/main.js")).toEqual({
      status: "supported",
      language: "javascript",
      coverage_level: "full",
    });
    expect(detectLanguageFromPath("app.py")).toMatchObject({ status: "supported", language: "python" });
    expect(detectLanguageFromPath("main.go")).toMatchObject({ status: "supported", language: "go" });
    expect(detectLanguageFromPath("App.java")).toMatchObject({ status: "supported", language: "java" });
    expect(detectLanguageFromPath("lib.rs")).toMatchObject({ status: "supported", language: "rust" });
    expect(detectLanguageFromPath("Main.kt")).toMatchObject({
      status: "supported",
      language: "kotlin",
      coverage_level: "partial",
    });
    expect(detectLanguageFromPath("widget.dart")).toMatchObject({
      status: "supported",
      language: "dart",
      coverage_level: "full",
    });
  });

  it("retorna unsupported para extensão desconhecida", () => {
    expect(detectLanguageFromPath("readme.md")).toEqual({ status: "unsupported" });
    expect(detectLanguageFromPath("image.png")).toEqual({ status: "unsupported" });
  });

  it("expõe lista de linguagens suportadas", () => {
    expect(SUPPORTED_LANGUAGES).toContain("typescript");
    expect(SUPPORTED_LANGUAGES).toContain("dart");
    expect(SUPPORTED_LANGUAGES.length).toBe(8);
  });
});
