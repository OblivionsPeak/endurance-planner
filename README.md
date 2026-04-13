# Endurance Race Planner

A local web app for planning iRacing endurance races (2.4h, 6h, 12h, 24h).

## Features

- **Setup** — enter race duration, lap time, fuel capacity, burn rate, pit loss time, and driver roster
- **Stint Plan** — auto-calculated stint table with fuel loads, pit windows, and a driver rotation timeline
- **Live Mode** — track current lap, get "pit in N laps" alerts, mark stints complete, log events
- **Export** — full strategy summary, print to PDF via browser

## Setup

1. **Create a virtual environment** (Python 3.9+):

```bash
cd endurance-planner
python -m venv venv
```

2. **Activate it:**

Windows:
```bat
venv\Scripts\activate
```

Mac/Linux:
```bash
source venv/bin/activate
```

3. **Install dependencies:**

```bash
pip install -r requirements.txt
```

4. **Run the app:**

```bash
python app.py
```

5. Open **http://localhost:5002** in your browser.

The SQLite database (`planner.db`) is created automatically on first run.

## Fuel Strategy Math

- **Effective fuel/lap** = `fuel_per_lap × mode_multiplier`
  - Save mode: ×0.92 (−8%)
  - Normal: ×1.00
  - Push mode: ×1.08 (+8%)
- **Laps per tank** = `floor((tank_capacity − 1_safety_lap_of_fuel) / fuel_per_lap)`
- **Laps per stint** = `min(laps_per_tank, fatigue_limit_in_laps)`
- **Fuel load per stint** = `laps_in_stint × fuel_per_lap + 1_lap_buffer`

## Stack

- Python 3.9+ / Flask
- Vanilla JS (no framework)
- SQLite (local, no server required)
- No auth, no build step
