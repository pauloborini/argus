/**
 * Serialização de payloads da CLI. Default **compacto** (sem pretty-print): o
 * pretty 2-spaces infla a contagem de tokens em ~30-40% em payloads
 * array-of-objects, e o consumidor primário é máquina (agente / `jq`). A flag
 * global `--pretty` reativa a identação para leitura humana.
 */
let prettyOutput = false;

export function setPrettyOutput(value: boolean): void {
  prettyOutput = value;
}

export function serializePayload(payload: unknown): string {
  return prettyOutput ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}
