@echo off
start "Live Transcription" cmd /k venv\Scripts\python.exe server.py
timeout /t 3 /nobreak >nul
start http://localhost:3000