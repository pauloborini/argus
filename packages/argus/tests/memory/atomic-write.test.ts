import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/memory/atomic-write.js";

describe("writeFileAtomic (MEMORY-ATOMIC-001)", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      try {
        chmodSync(tempDir, 0o700);
      } catch {
        // Ignora se já estiver com permissão ou apagado
      }
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function makeTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "argus-atomic-write-test-"));
    return tempDir;
  }

  it("§7.1 cria arquivo com conteudo integral e nenhum .tmp residual", () => {
    const dir = makeTempDir();
    const target = join(dir, "nota.md");
    const content = "# Conteúdo integral da nota\nLinha 2 de teste.\n";

    writeFileAtomic(target, content);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(content);

    const files = readdirSync(dir);
    expect(files).toEqual(["nota.md"]);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("§7.2 reescrita preserva o mode do arquivo existente e atualiza conteudo", () => {
    if (process.platform === "win32") {
      // Windows não suporta bits de permissão POSIX (0o600).
      return;
    }

    const dir = makeTempDir();
    const target = join(dir, "config-secreta.json");
    const initialContent = '{"secret": "initial"}\n';
    writeFileSync(target, initialContent, { encoding: "utf-8", mode: 0o600 });
    chmodSync(target, 0o600);

    const initialStat = statSync(target);
    expect(initialStat.mode & 0o777).toBe(0o600);

    const updatedContent = '{"secret": "updated"}\n';
    writeFileAtomic(target, updatedContent);

    expect(readFileSync(target, "utf-8")).toBe(updatedContent);
    const updatedStat = statSync(target);
    expect(updatedStat.mode & 0o777).toBe(0o600);

    const files = readdirSync(dir);
    expect(files).toEqual(["config-secreta.json"]);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("§7.3 falha de escrita preserva arquivo original intacto e nao deixa .tmp residual", () => {
    if (process.platform === "win32") {
      // Chmod de diretório para leitura somente (0o500) é específico de POSIX.
      return;
    }

    const dir = makeTempDir();
    const target = join(dir, "nota-intacta.md");
    const originalContent = "conteúdo original que não pode ser corrompido";
    writeFileSync(target, originalContent, "utf-8");

    // Remove permissão de escrita do diretório
    chmodSync(dir, 0o500);

    try {
      expect(() => {
        writeFileAtomic(target, "novo conteúdo que deve falhar");
      }).toThrow();
    } finally {
      // Restaura permissão para poder verificar o estado e limpar
      chmodSync(dir, 0o700);
    }

    // Arquivo original deve permanecer idêntico ao original
    expect(readFileSync(target, "utf-8")).toBe(originalContent);

    // Nenhum arquivo .tmp residual no diretório
    const files = readdirSync(dir);
    expect(files).toEqual(["nota-intacta.md"]);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
