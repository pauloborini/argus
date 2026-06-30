import { describe, expect, it } from "vitest";
import {
  RESPONSE_STATES,
  deriveConfidence,
  isResponseState,
  stubResponse,
} from "../src/contracts/response-state.js";

describe("response-state", () => {
  it("define os cinco estados canônicos S02", () => {
    expect(RESPONSE_STATES).toHaveLength(5);
    expect(RESPONSE_STATES).toEqual([
      "sucesso",
      "ambigua",
      "stale",
      "parcial",
      "falha",
    ]);
  });

  it("stubResponse inclui state e message para cada estado", () => {
    for (const state of RESPONSE_STATES) {
      const envelope = stubResponse(state, `mensagem-${state}`);
      expect(envelope.state).toBe(state);
      expect(envelope.message).toBe(`mensagem-${state}`);
      expect(envelope.confidence).toBeDefined();
    }
  });

  it("deriveConfidence respeita guardas S02", () => {
    expect(deriveConfidence("sucesso")).toBe("high");
    expect(deriveConfidence("parcial")).toBe("medium");
    expect(deriveConfidence("falha")).toBe("low");
    expect(deriveConfidence("stale")).toBe("low");
    expect(deriveConfidence("ambigua")).toBe("low");
  });

  it("isResponseState valida enum fechado", () => {
    expect(isResponseState("sucesso")).toBe(true);
    expect(isResponseState("invalido")).toBe(false);
  });
});
