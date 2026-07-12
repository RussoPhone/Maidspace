# Release Checklist

Use esta lista antes de disponibilizar uma build publica do MaidSpace.

## Build

```powershell
npm install
npm test
cargo check --manifest-path src-core/add-core/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run maidspace:build:local
```

## Smoke test

1. Abrir `src-tauri\target\release\maidspace.exe`.
2. Varrer uma pasta pequena.
3. Confirmar que a UI continua responsiva durante a varredura.
4. Abrir `Relocar`, simular e conferir o relatorio.
5. Executar uma limpeza pequena para uma pasta de teste.
6. Cancelar uma limpeza em andamento e confirmar status cancelado.
7. Abrir o relatorio e confirmar manifesto usado, itens e erros.

## Testes de risco

- Pasta com arquivo em uso.
- Pasta sem permissao.
- Destino no mesmo volume.
- Destino em volume diferente.
- Arquivo grande entre volumes para conferir progresso por bytes.
- Projeto de codigo com `.git`, `node_modules`, `target`, `dist`.
- Pasta pessoal como `Documents`, `Desktop`, `Pictures`, `OneDrive`.

## Criterio minimo

- Nada move sem confirmacao.
- Delete padrao vira quarentena.
- UI nao congela em scan ou limpeza.
- Log nao e fila de execucao.
- Plano/manifesto e a fonte auditavel.
- Cancelamento para antes do proximo arquivo seguro.

