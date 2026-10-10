$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot 'backend/.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    throw 'Backend virtual environment missing. Follow the setup steps in README.md.'
}
& $taskPython (Join-Path $PSScriptRoot 'dev.py') @args
exit $LASTEXITCODE
