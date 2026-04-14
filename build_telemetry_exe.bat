@echo off
title Endurance Telemetry - Build EXE
echo.
echo  Building standalone EXE (no Python install required on target PC)
echo  ==================================================================
echo.

:: Activate the telemetry venv
if not exist "telemetry_venv\Scripts\python.exe" (
    echo  Run setup_telemetry.bat first.
    pause
    exit /b 1
)

:: Install PyInstaller into the telemetry venv
telemetry_venv\Scripts\pip install --quiet pyinstaller

:: Build single-file EXE, no console window
telemetry_venv\Scripts\pyinstaller ^
    --onefile ^
    --noconsole ^
    --name "EnduranceTelemetry" ^
    --icon NONE ^
    telemetry_agent.py

echo.
if exist "dist\EnduranceTelemetry.exe" (
    echo  Build successful!
    echo  Distribute:  dist\EnduranceTelemetry.exe
    echo.
    echo  Recipients just need to:
    echo    1. Copy EnduranceTelemetry.exe anywhere on their PC
    echo    2. Double-click it
    echo    3. Enter the Server URL and Plan ID, click Start
) else (
    echo  Build failed. Check output above for errors.
)
echo.
pause
