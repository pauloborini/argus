# REFERENCE: THIRD PARTY

Procedência das referências externas. Acionado por `index/feature.md` e `index/refactoring.md` quando o diff toca código inspirado.

## Regra

Argus foi implementado de forma própria. Código de terceiros só entra com licença compatível, com origem registrada e notices mantidos.

## Fontes

| Fonte | Licença | Uso permitido |
|---|---|---|
| `GitNexus` | PolyForm-Noncommercial-1.0.0 | **clean-room only** — referência de produto e algoritmo, nunca base de código |
| `CodeGraph` | MIT | referência comportamental e de benchmark; installer/MCP/sync como inspiração |
| `Headroom` | Apache-2.0 | inspiração do packer (compressão, reversibilidade, handles) |
| `Understand Anything` | MIT | ganho pequeno; quase todo descartado no cenário |

## Notices

- `THIRD_PARTY_NOTICES.md` (raiz) declara que a release não contém trechos literais das bases e que dependências npm preservam licença nos próprios pacotes; a lista exata vive no lockfile.
- `packages/argus/THIRD_PARTY_NOTICES.md` acompanha o tarball publicado.
- Ao reaproveitar qualquer trecho no futuro: registrar origem no arquivo e manter o notice correspondente.
