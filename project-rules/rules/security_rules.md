# RULES: SECURITY

## Papel

Definir as normas de segredo, PII, confinamento de path e privacidade local.

## Modelo de segurança

- Processamento e persistência são **locais**: nada é indexado ou enviado a serviço remoto, e o contexto recuperado não sai do workspace.
- `.argus/` pertence ao workspace indexado; é o único estado do produto.
- Nenhuma tool executa código do workspace.
- Todo path lido ou devolvido permanece confinado ao workspace; requisição fora dele falha com `E_PATH_OUTSIDE_WORKSPACE`.

## Handles e entrada

- `retrieve` aceita apenas IDs opacos no formato `rh_<16 hex>`/`mh_<16 hex>`; nunca path.
- Entrada de tool é validada antes de tocar disco; entrada inválida é `falha`, não erro não tratado.

## Segredos e saída

- Nunca expor segredo, credencial, token, URL privada ou PII em resposta de tool, log ou mensagem de erro.
- `.env*` real fica fora do git; só `.env.example` com placeholders é versionado.
- Segredo no arquivo do próprio workspace que esteja no `.gitignore` não é indexado; o checklist de privacidade do release prova os seis itens: gitignored fora do índice, path fora do workspace rejeitado, handles opacos, sem LLM externo sem config, nenhum segredo em saída de tool, catálogo de 12 tools.

## LLM e embedding

- Embeddings são locais; sem configuração explícita de provider não há chamada a LLM externo — o runtime devolve `parcial` com limitation declarada em vez de certeza.
- Chaves de LLM, quando configuradas, vivem em config local do workspace e nunca no git.

## stdout do MCP

- O stdout do servidor stdio é protocolo: nenhum `console.log` no caminho stdio; diagnóstico vai para stderr ou modo quiet (DEC-018).

## Gatilhos típicos

- segredo, PII, permissão, path sensível ou ambiente;
- log, telemetria ou serialização de payload;
- mudança em handle, retrieve ou confinamento de workspace.
