$ErrorActionPreference = "Stop"

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Add-PathIfExists($path) {
  if ((Test-Path $path) -and ($env:PATH -notlike "*$path*")) {
    $env:PATH = "$path;$env:PATH"
  }
}

function Test-VcBuildTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    return $false
  }

  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return [bool]$installPath
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

if (-not (Test-VcBuildTools)) {
  if (-not (Test-Command "winget")) {
    throw "Visual Studio Build Tools com C++ nao encontrado. Instale o workload Desktop development with C++ e rode este setup novamente."
  }
  Write-Host "Instalando Visual Studio Build Tools C++..."
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --accept-package-agreements --accept-source-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}

Write-Host "Instalando dependencias npm..."
npm install

Write-Host "Verificando motor Rust..."
cmd /c scripts\with-vsdev.cmd cargo check --manifest-path src-core/add-core/Cargo.toml
cmd /c scripts\with-vsdev.cmd cargo check --manifest-path src-tauri/Cargo.toml

Write-Host "Setup concluido. Use MaidSpace.cmd ou npm run desktop."
