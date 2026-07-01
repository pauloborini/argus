/**
 * Estados operacionais alinhados a `.argus/contracts/ESTADOS_RESPOSTA.md`
 */
export type ResponseState =
  | "sucesso"
  | "ambigua"
  | "stale"
  | "parcial"
  | "falha";

export type Confidence = "high" | "medium" | "low";

/** Envelope mínimo de resposta operacional */
export interface OperationalEnvelope {
  state: ResponseState;
  message?: string;
  confidence?: Confidence;
  limitations?: string[];
  staleness_hint?: string;
}

/** Deriva confidence a partir do state (guardas S02) */
export function deriveConfidence(state: ResponseState): Confidence | undefined {
  switch (state) {
    case "sucesso":
      return "high";
    case "parcial":
      return "medium";
    case "ambigua":
    case "stale":
    case "falha":
      return "low";
  }
}

/** Helper para respostas stub honestas */
export function stubResponse(
  state: ResponseState,
  message: string,
  extras?: Partial<Omit<OperationalEnvelope, "state" | "message">>,
): OperationalEnvelope {
  const envelope: OperationalEnvelope = {
    state,
    message,
    confidence: extras?.confidence ?? deriveConfidence(state),
  };

  if (extras?.limitations?.length) {
    envelope.limitations = extras.limitations;
  }
  if (extras?.staleness_hint) {
    envelope.staleness_hint = extras.staleness_hint;
  }

  return envelope;
}

export const RESPONSE_STATES: readonly ResponseState[] = [
  "sucesso",
  "ambigua",
  "stale",
  "parcial",
  "falha",
] as const;

export function isResponseState(value: string): value is ResponseState {
  return (RESPONSE_STATES as readonly string[]).includes(value);
}
