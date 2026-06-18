import { afterEach, describe, expect, it, vi } from "vitest";

// Mock do runSync: isola o pipeline do índice real para testar só o debounce.
const { runSyncMock } = vi.hoisted(() => ({ runSyncMock: vi.fn(async () => 0) }));
vi.mock("../src/commands/sync.js", () => ({ runSync: runSyncMock }));

import { WorkspacePipeline } from "../src/daemon/pipeline.js";

describe("WorkspacePipeline debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
    runSyncMock.mockClear();
  });

  it("coalesce rajada em um único sync após o debounce", async () => {
    vi.useFakeTimers();
    const pipeline = new WorkspacePipeline("/ws", 400, {}, 3_000);
    pipeline.enqueue(["/ws/a.ts"]);
    pipeline.enqueue(["/ws/b.ts"]);

    await vi.advanceTimersByTimeAsync(399);
    expect(runSyncMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    expect(runSyncMock.mock.calls[0]?.[0]).toMatchObject({ cwd: "/ws" });
    pipeline.dispose();
  });

  it("capa a espera em maxDebounceMs sob saves contínuos (anti-starvation)", async () => {
    vi.useFakeTimers();
    const pipeline = new WorkspacePipeline("/ws", 400, {}, 1_000);

    // Evento a cada 200ms (< debounce de 400): sem o teto, o timer rearmaria
    // para sempre e nenhum sync dispararia.
    for (let i = 0; i < 10; i += 1) {
      pipeline.enqueue([`/ws/f${i}.ts`]);
      await vi.advanceTimersByTimeAsync(200);
    }

    // O teto de 1000ms forçou ao menos um sync apesar da rajada contínua.
    expect(runSyncMock).toHaveBeenCalled();
    pipeline.dispose();
  });
});
