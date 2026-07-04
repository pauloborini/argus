# Argus

Local code retrieval and context packing for coding agents. Local-first, no UI,
CLI + MCP. · *Runtime local de code retrieval e context packing para agentes.*

```bash
gh release download v2.1.0 --repo pauloborini/argus --pattern 'argus-*.tgz' -D /tmp
npm install -g /tmp/argus-2.1.0.tgz
argus init
argus index
argus search "calculateTotal"
argus serve --mcp
```

Not on the public npm registry as `argus` — see the root [README](https://github.com/pauloborini/argus/blob/main/README.md#install).

Exposes nine MCP tools: `search`, `explore`, `trace`, `impact`, `diff_impact`,
`files`, `pack_context`, `retrieve`, `status`.

## Documentation

- README — [English](https://github.com/pauloborini/argus/blob/main/README.md)
  · [Português](https://github.com/pauloborini/argus/blob/main/README.pt-BR.md)
- Commands — [English](https://github.com/pauloborini/argus/blob/main/COMMANDS.md)
  · [Português](https://github.com/pauloborini/argus/blob/main/COMMANDS.pt-BR.md)
