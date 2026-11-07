@echo off
chcp 65001 >nul
title Chaoxing Homework Overview
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found in PATH.
  echo   Install Node.js LTS from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Chaoxing homework overview...
echo.

node server.js

echo.
echo   Server stopped.
pause
