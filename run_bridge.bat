@echo off
title Endurance Race Planner — Telemetry Bridge

:: Check Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo Python is not installed or not in PATH.
    echo Download it from: https://www.python.org/downloads/
    echo Make sure to tick "Add Python to PATH" during install.
    pause
    exit /b 1
)

:: Run the bridge (it installs its own dependencies automatically)
python "%~dp0telemetry_bridge.py"

if errorlevel 1 (
    echo.
    echo Something went wrong. See the error above.
    pause
)
