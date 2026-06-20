$ErrorActionPreference = "Stop"

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Add-PathIfExists($path) {
  if ((Test-Path $path) -and ($env:PATH -notlike "*$path*")) {
    $env:PATH = "$path;$env:PATH"
  }
}

Write-Host "MaidSpace setup"

Add-PathIfExists "$env:ProgramFiles\nodejs"
Add-PathIfExists "$env:USERPROFILE\.cargo\bin"

if (-not (Test-Command "node") -or -not (Test-Command "npm")) {
  if (-not (Test-Command "winget")) {
    throw "Node.js nao encontrado. Instale Node.js LTS e rode este setup novamente."
  }
  Write-Host "Instalando Node.js LTS..."
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  Add-PathIfExists "$env:ProgramFiles\nodejs"
}

if (-not (Test-Command "cargo")) {
  if (-not (Test-Command "winget")) {
    throw "Rust/Cargo nao encontrado. Instale Rustup e rode este setup novamente."
  }
  Write-Host "Instalando Rustup..."
  winget install --id Rustlang.Rustup -e --source winget --accept-package-agreements --accept-source-agreements
  Add-PathIfExists "$env:USERPROFILE\.cargo\bin"
}

if (Test-Command "rustup") {
  $rustupShow = rustup show 2>$null | Out-String
  if ($rustupShow -match "no active toolchain") {
    Write-Host "Ativando Rust stable para o MaidSpace..."
    rustup default stable
  }
}

Write-Host "Instalando dependencias npm..."
npm install

Write-Host "Verificando motor Rust..."
cargo check --manifest-path src-core/add-core/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml

Write-Host "Setup concluido. Use MaidSpace.cmd ou npm run desktop."
