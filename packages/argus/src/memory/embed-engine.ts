import { VaultEngine } from "./vault-engine.js";

export class EmbedEngine {
  static embed(cwd: string = process.cwd()) {
    return VaultEngine.embed(cwd);
  }
}

