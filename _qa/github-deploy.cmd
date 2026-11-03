@echo off
setlocal
cd /d "%~dp0.."
if not exist "C:\Program Files\Git\bin\bash.exe" (
  echo Git Bash not found at C:\Program Files\Git\bin\bash.exe
  echo Run this from Git Bash instead: bash _qa/github-deploy.sh
  pause
  exit /b 1
)
"C:\Program Files\Git\bin\bash.exe" _qa/github-deploy.sh
echo.
pause
