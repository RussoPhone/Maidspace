# MaidSpace Architecture

## Pastas principais

- `public/`: interface web usada pelo app desktop e pelo servidor local.
- `server.js`: servidor HTTP local, fallback de scan e jobs de limpeza.
- `src/add/`: varredura, classificacao e grafo de dependencias.
- `src/are/`: plano de limpeza e estimativas de espaco.
- `src/alc/`: preferencias, estado continuo, manifesto e quarentena.
- `src/scan/`: inventario rapido para expandir candidatos grandes.
- `src-tauri/`: app desktop Windows e comandos nativos.
- `tests/`: testes Node do pipeline, manifesto e rotas HTTP.

## Fluxo de limpeza

1. A UI coleta raiz, destino, modo e filtros.
2. O plano gera a lista auditavel de arquivos.
3. A simulacao cria relatorio sem mover nada.
4. A execucao real usa o plano auditavel como fonte da verdade.
5. O log registra resultados; ele nao e fila de execucao.
6. Arquivos apagados por padrao vao para quarentena.

## Progresso

- Scan progressivo usa eventos quando o app desktop permite.
- No servidor local, limpeza real usa `/api/alc/relocate-job`.
- A UI consulta `/api/alc/jobs/:jobId` para atualizar progresso sem travar.
- Cancelamento marca a operacao e para antes do proximo arquivo seguro.

## Regra de manutencao

Mantenha mudancas pequenas. A interface pode mudar, mas a selecao de arquivos e as validacoes de seguranca devem ser alteradas apenas com testes.

## Leitura complementar

- [PERFORMANCE.md](PERFORMANCE.md)
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)
