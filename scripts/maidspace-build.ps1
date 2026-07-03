$ErrorActionPreference = "Stop"

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

cmd /c scripts\with-vsdev.cmd npm run maidspace:build
