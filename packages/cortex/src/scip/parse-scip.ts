/**
 * Parser SCIP: decodifica index.scip (protobuf) usando protobufjs (dep opcional/lazy).
 * Ausência da dep → ScipUnavailableError (W_SCIP_UNAVAILABLE).
 */
import { readFileSync } from "node:fs";
import type { ScipDocument, ScipIndex, ScipOccurrence, ScipRange } from "./types.js";
import { SymbolRole } from "./types.js";

export class ScipUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScipUnavailableError";
  }
}

interface ProtobufType {
  decode(buf: Uint8Array): RawIndex;
}
interface ProtobufNamespace {
  add(child: unknown): ProtobufNamespace;
}
interface ProtobufField {
  // marker
}
interface ProtobufModule {
  Type: new (name: string, options?: object) => ProtobufType & ProtobufNamespace;
  Field: new (name: string, id: number, type: string, rule?: string) => ProtobufField;
}

interface RawOccurrence {
  range?: number[];
  symbol?: string;
  symbolRoles?: number;
}
interface RawDocument {
  relativePath?: string;
  occurrences?: RawOccurrence[];
}
interface RawIndex {
  documents?: RawDocument[];
}

let cachedProto: ProtobufType | null = null;

async function loadProtoType(): Promise<ProtobufType> {
  if (cachedProto) return cachedProto;

  let protobufjs: ProtobufModule;
  try {
    protobufjs = (await import("protobufjs")) as unknown as ProtobufModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ScipUnavailableError(
      `W_SCIP_UNAVAILABLE: dependência protobufjs indisponível (${detail}). Instale com: npm i protobufjs`,
    );
  }

  const Occurrence = new protobufjs.Type("Occurrence")
    .add(new protobufjs.Field("range", 1, "int32", "repeated"))
    .add(new protobufjs.Field("symbol", 2, "string"))
    .add(new protobufjs.Field("symbolRoles", 3, "int32"));

  const Document = new protobufjs.Type("Document")
    .add(new protobufjs.Field("relativePath", 1, "string"))
    .add(new protobufjs.Field("occurrences", 2, "Occurrence", "repeated"))
    .add(Occurrence as unknown as ProtobufField);

  const Index = new protobufjs.Type("Index")
    .add(new protobufjs.Field("documents", 1, "Document", "repeated"))
    .add(Document as unknown as ProtobufField);

  cachedProto = Index as unknown as ProtobufType;
  return cachedProto;
}

function decodeRange(raw: number[]): ScipRange {
  if (raw.length === 3) {
    return { startLine: raw[0]!, startCol: raw[1]!, endLine: raw[0]!, endCol: raw[2]! };
  }
  return { startLine: raw[0]!, startCol: raw[1]!, endLine: raw[2]!, endCol: raw[3]! };
}

function decodeOccurrence(raw: RawOccurrence): ScipOccurrence | null {
  const symbol = raw.symbol;
  if (!symbol || !raw.range || raw.range.length < 3) return null;
  const roles = raw.symbolRoles ?? 0;
  return {
    range: decodeRange(raw.range),
    symbol,
    symbolRoles: roles,
  };
}

function decodeDocument(raw: RawDocument): ScipDocument | null {
  const relativePath = raw.relativePath;
  if (!relativePath) return null;
  const occurrences: ScipOccurrence[] = [];
  for (const occ of raw.occurrences ?? []) {
    const decoded = decodeOccurrence(occ);
    if (decoded) occurrences.push(decoded);
  }
  return { relativePath, occurrences };
}

/** Decodifica um buffer protobuf SCIP Index em memória. */
export async function decodeScipBuffer(buf: Uint8Array): Promise<ScipIndex> {
  const IndexType = await loadProtoType();
  const raw = IndexType.decode(buf);
  const documents: ScipDocument[] = [];
  for (const doc of raw.documents ?? []) {
    const decoded = decodeDocument(doc);
    if (decoded) documents.push(decoded);
  }
  return { documents };
}

/** Lê e decodifica um arquivo index.scip do disco. */
export async function parseScipFile(path: string): Promise<ScipIndex> {
  const buf = readFileSync(path);
  return decodeScipBuffer(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

/** Helper: extrai o nome curto (último segmento) de um moniker SCIP. */
export function scipSymbolShortName(moniker: string): string {
  const cleaned = moniker.replace(/\.$/, "").replace(/[()]/g, "");
  const segments = cleaned.split(/[./`]/);
  return segments.at(-1) ?? moniker;
}

/** Checa se uma occurrence é definição (bit 0x1 no symbolRoles bitmask). */
export function isDefinition(occ: ScipOccurrence): boolean {
  return (occ.symbolRoles & SymbolRole.Definition) !== 0;
}
