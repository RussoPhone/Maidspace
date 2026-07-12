# Pesquisa e decisao do MaidSpace

## Objetivo

MaidSpace precisa inventariar o armazenamento inteiro, achar espaco liberavel em massa e operar como software local. O alvo nao e "andar pasta por pasta ate cansar"; o alvo e manter um indice leve do disco e so aprofundar a leitura quando houver sinal de ganho ou risco.

## O que os scanners rapidos fazem

- WizTree ganha velocidade em NTFS porque le a Master File Table diretamente. Isso evita abrir cada arquivo e transforma a primeira etapa em leitura de metadados.
- Everything usa indice local de nomes e mantem mudancas com o USN Journal. Ele tambem mostra que a parte constante deve ser um servico local pequeno, nao uma API web.
- WinDirStat e SpaceSniffer acertam na visualizacao: o usuario entende espaco por area, nao por lista infinita. O grafo do MaidSpace deve manter zoom/pan, mas o resumo espacial deve ser uma visao compacta por blocos.
- Storage Sense mostra o contrato seguro para limpeza automatica: temporarios, lixeira e conteudo claramente local/cacheado; downloads e conteudo pessoal exigem configuracao ou confirmacao.

## Decisao de algoritmo

1. **Inventario horizontal primeiro**
   - Ler o maximo de metadados possivel: caminho, tamanho, alocacao, datas, atributos, extensao e identificadores.
   - Em Windows/NTFS, evoluir o motor Rust para `FSCTL_ENUM_USN_DATA`, `FSCTL_READ_USN_JOURNAL` e, quando preciso, `GetFileInformationByHandleEx`.
   - Enquanto a leitura MFT/USN completa nao entra, usar o inventario turbo via `robocopy /L /E /BYTES /FP /TS /XJ` como ponte local.

2. **Banco auxiliar de limpeza**
   - Guardar o ultimo snapshot por volume.
   - Atualizar por heartbeat de grupos DPN: extensao, idade, pasta pesada, risco, dependencia e uso recente.
   - Usar USN Journal para scans incrementais depois do primeiro baseline.

3. **HF antes de DFS**
   - Uma Heavy Folder nao vira "sistema" por conter um arquivo de sistema. Ela vira um bloco misto.
   - O motor estima o bloco inteiro, separa candidatos e roda DFS/probe apenas em subarvores suspeitas.
   - Cada probe tem limite de tempo e de bytes; arquivos gigantes nunca sao lidos linearmente para decidir limpeza basica.

4. **Plano por meta**
   - O usuario diz quanto quer liberar.
   - O plano escolhe o menor modo que atinge a meta: baixo, medio ou alto.
   - Quando a lista detalhada foi compactada, o plano pode usar estimativa total do inventario e pedir uma segunda passagem focada so nos blocos necessarios.

5. **Limpeza constante sem interferir**
   - Rodar em baixa prioridade/idle.
   - Nunca apagar sistema, dependencias essenciais ou conteudo recente.
   - Preferir quarentena, lixeira, mover caches seguros e apenas depois exclusao final.
   - Reaprender com arquivos que o usuario restaura ou marca como manter.

## Microalgoritmos

- **Score de espaco**: bytes + idade + perfil seguro + baixa dependencia - uso recente - protecao.
- **Retencao top-K**: manter todos os totais, mas detalhar so os maiores candidatos por grupo.
- **DPN grouping**: agrupar por extensao, pacote, pasta raiz, provedor, idade e acesso.
- **HF splitter**: para cada pasta pesada, dividir em filhos por tamanho; filhos seguros entram no plano antes dos filhos mistos.
- **DFS limitado**: aprofundar somente candidatos de alto ganho com `deadlineMs`, `maxFiles`, `maxBytesRead` e abort cooperativo.
- **Cooldown**: se um item foi usado recentemente ou restaurado, ele sai dos candidatos por uma janela.

## O que nao fazer

- Nao usar DFS completo como primeira etapa.
- Nao ler conteudo de arquivos grandes para decidir se ocupam espaco.
- Nao marcar `Program Files`, `Users` ou `Program Files (x86)` inteiros como intocaveis.
- Nao mover/apagar automaticamente sem uma politica auditavel.
- Nao depender de servidor web para uma tarefa que precisa de metadados locais e permissao local.

## Implementacao atual

- Nome do sistema trocado para MaidSpace.
- Dependencias Node instaladas e Tauri CLI travado no lockfile.
- Rust instalado e `cargo check` validado para o core e para o app Tauri.
- Interface Tauri chama `analyze_maidspace` localmente; Node fica como fallback.
- O plano aceita meta de GB e calcula o menor modo possivel.
- Inventario JS turbo calcula totais completos e compacta apenas os detalhes.
- Grafo ganhou zoom/pan e clique para detalhes.

## Proximo salto tecnico

1. Implementar leitor NTFS nativo no Rust com:
   - enumeracao MFT via USN;
   - reconstrucao de paths por `FileReferenceNumber` e `ParentFileReferenceNumber`;
   - banco local por volume;
   - watcher incremental por USN.
2. Criar executor de limpeza em duas fases:
   - `prepare`: calcular plano, validar locks e simular ganho;
   - `commit`: mover para quarentena/lixeira com manifesto de rollback.
3. Adicionar agendamento semanal/local com pausa por bateria, CPU alta ou processo em primeiro plano.

## Fontes consultadas

- Microsoft Learn: Change Journals - https://learn.microsoft.com/en-us/windows/win32/fileio/change-journals
- Microsoft Learn: FSCTL_ENUM_USN_DATA - https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_enum_usn_data
- Microsoft Learn: Master File Table - https://learn.microsoft.com/en-us/windows/win32/fileio/master-file-table
- Microsoft Support: Storage Sense - https://support.microsoft.com/en-us/windows/manage-drive-space-with-storage-sense-654f6ada-7bfc-45e5-966b-e24aded96ad5
- Microsoft Learn: Configure Storage Sense - https://learn.microsoft.com/en-us/windows/configuration/storage/storage-sense
- WizTree: disk analyzer com leitura direta da MFT em NTFS - https://diskanalyzer.com/
- voidtools Everything: indices locais, sort rapido e monitoramento em tempo real - https://www.voidtools.com/support/everything/indexes/
- WinDirStat: treemap e tres paineis de leitura espacial - https://windirstat.dev/
- SpaceSniffer: treemap para percepcao rapida de arquivos e pastas grandes - https://www.uderzo.it/main_products/space_sniffer/
