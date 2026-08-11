<!-- Language: **English** · [Português](SECURITY.pt-BR.md) -->

# Security

Report vulnerabilities privately through the repository's GitHub Security
Advisories. Do not open a public issue containing an exploit, indexed content,
or secret.

## Model

- Processing and persistence are local.
- `.argus/` belongs to the indexed workspace.
- `retrieve_handle` accepts only opaque IDs in the `rh_<16 hex>` format.
- No tool executes workspace code.
- Returned and read paths must remain confined to the workspace.

Supported versions: the latest minor release in the current `2.x` major line.
