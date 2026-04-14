@echo off
:: Run the Endurance Telemetry Agent GUI
:: Double-click this file to launch.

if not exist "telemetry_venv\Scripts\pythonw.exe" (
    echo  Setup not complete. Running setup now...
    call setup_telemetry.bat
)

start "" "telemetry_venv\Scripts\pythonw.exe" "%~dp0telemetry_agent.py"
