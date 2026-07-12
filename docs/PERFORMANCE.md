# Performance

## Objetivos

- Manter a interface responsiva durante varredura e limpeza.
- Mostrar progresso util em arquivos grandes.
- Evitar enviar listas enormes para a UI quando um resumo auditavel basta.
- Preservar seguranca: sem paralelismo cego em operacoes de arquivo.

## Aplicado

- Varredura HTTP progressiva usa compactacao automatica em resultados grandes.
- A UI mostra amostras e totais, sem transformar log ou tabela visivel em fila real.
- Limpeza HTTP roda como job e a UI consulta progresso por `jobId`.
- Copia entre volumes no fallback usa stream com progresso por bytes.
- Movimento no mesmo volume continua usando `rename`, que tende a ser o caminho rapido.
- Tabelas grandes usam limite visual e delegacao de evento para reduzir listeners.
- `event.listen` indisponivel no Tauri cai para modo compativel em vez de quebrar o fluxo.

## Gargalos esperados

- Muitos arquivos pequenos: custo alto de metadados, antivirus e criacao de diretorios.
- Arquivos grandes entre volumes: limitado por I/O; progresso deve continuar visivel.
- Permissoes e arquivos em uso: registrar erro e seguir para o proximo item.
- UI com listas enormes: usar resumo, filtros e amostra, nao renderizar tudo.

## Proximas otimizacoes seguras

1. Progresso por bytes tambem no executor Tauri nativo durante copia manual.
2. Inventario NTFS por USN/MFT no core Rust.
3. Cache incremental por volume.
4. Medicao separada de antivirus/permissao/arquivo bloqueado.
5. Configuracao de intensidade com limites claros, sem paralelismo agressivo por padrao.

