@echo off
title Endurance Telemetry - First Time Setup
echo.
echo  Endurance Telemetry Agent - Setup
echo  ==================================
echo.
echo  This only needs to be run once.
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python is not installed or not on PATH.
    echo  Download Python from https://python.org
    echo.
    pause
    exit /b 1
)

:: Create telemetry venv
echo  Creating virtual environment...
python -m venv telemetry_venv
if errorlevel 1 (
    echo  ERROR: Failed to create virtual environment.
    pause
    exit /b 1
)

:: Install packages
echo  Installing packages (pyirsdk + requests)...
telemetry_venv\Scripts\pip install --quiet -r requirements_telemetry.txt
if errorlevel 1 (
    echo  ERROR: Package installation failed.
    pause
    exit /b 1
)

echo.
echo  Setup complete!
echo  You can now double-click  run_telemetry.bat  to start the agent.
echo.
pause
