# MaidSpace

MaidSpace e um app local para Windows que encontra arquivos pesados, mostra risco e ajuda a mover ou colocar itens em quarentena com revisao do usuario.

O app nao deve mover nem apagar arquivos sem um plano auditavel e uma confirmacao clara.

## Fluxo

1. Escolha uma pasta ou disco.
2. Clique em `Varrer`.
3. Revise o grafo e o plano.
4. Simule quando quiser conferir a fila.
5. Execute a limpeza apenas depois de revisar destino, total e arquivos.

## Interface

- **Grafo** mostra grupos, risco e tamanho.
- **Plano** mostra destino, total planejado, etapas e progresso.
- **Detalhes** ficam recolhidos para nao poluir a tela.
- **Relatorio** registra o que foi planejado e o que aconteceu.

## Rodar no Windows

```powershell
npm run setup
npm run desktop
```

Tambem existem atalhos:

```text
Setup-MaidSpace.cmd
MaidSpace.cmd
```

## Rodar no navegador local

```powershell
npm install
npm start
```

Abra o endereco mostrado no terminal.

## Build

```powershell
npm run maidspace:build:local
```

Saidas comuns:

- `src-tauri\target\release\maidspace.exe`
- `src-tauri\target\release\bundle\nsis\`
- `src-tauri\target\release\bundle\msi\`

## Testes

```powershell
npm test
cargo test --manifest-path src-core/add-core/Cargo.toml
```

## Estrutura

Veja [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Performance

Veja [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
