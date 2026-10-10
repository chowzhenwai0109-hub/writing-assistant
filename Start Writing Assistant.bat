@echo off
setlocal
title Writing Assistant
pushd "%~dp0"
if not exist "backend\.venv\Scripts\python.exe" (
  echo Python environment is missing. Follow the setup steps in README.md.
  popd
  pause
  exit /b 1
)
"backend\.venv\Scripts\python.exe" "scripts\dev.py" --menu --open-browser %*
set "writingExit=%errorlevel%"
popd
if not "%writingExit%"=="0" pause
exit /b %writingExit%
