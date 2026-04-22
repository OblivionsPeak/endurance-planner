"""
Endurance Race Planner — iRacing Telemetry Bridge
==================================================
Runs locally on your racing PC alongside iRacing.
Reads the iRacing shared memory and pushes live data
(current lap, fuel level, lap times) to your planner.

Requirements:
    pip install pyirsdk requests

Usage:
    python telemetry_bridge.py --url https://your-app.railway.app --plan 42

Arguments:
    --url     Base URL of your Endurance Race Planner (no trailing slash)
    --plan    Plan ID to push data to (visible as "ID: XX" in the app header)
    --driver  Your driver name as entered in the plan (for lap time attribution)
    --fuel-unit  'gal' (default) or 'l' — matches your plan's fuel unit
"""

import argparse
import time
import sys
import requests

try:
    import irsdk
except ImportError:
    print("ERROR: pyirsdk not installed. Run: pip install pyirsdk requests")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
POLL_INTERVAL    = 0.5    # seconds between iRacing polls
TELEMETRY_EVERY  = 1.0    # seconds between telemetry state pushes
LAP_DEBOUNCE_S   = 5.0    # seconds to wait after a lap completes before logging

def parse_args():
    p = argparse.ArgumentParser(description='iRacing → Endurance Planner telemetry bridge')
    p.add_argument('--url',       required=True,  help='Planner base URL')
    p.add_argument('--plan',      required=True,  type=int, help='Plan ID')
    p.add_argument('--driver',    default='',     help='Your driver name (for lap attribution)')
    p.add_argument('--fuel-unit', default='gal',  choices=['gal', 'l'], help='Fuel unit')
    return p.parse_args()


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------
def main():
    args    = parse_args()
    base    = args.url.rstrip('/')
    plan_id = args.plan
    driver  = args.driver.strip()
    fuel_unit = args.fuel_unit

    ir = irsdk.IRSDK()
    ir.startup()

    print(f"[Bridge] Connecting to iRacing...")
    print(f"[Bridge] Target: {base}  Plan ID: {plan_id}  Driver: '{driver or '(any)'}'")
    print(f"[Bridge] Fuel unit: {fuel_unit}")
    print()

    last_lap_logged   = 0      # iRacing lap number of last logged lap
    last_telemetry_t  = 0.0    # wall-clock time of last telemetry push
    last_lap_time_s   = None

    while True:
        try:
            if not ir.is_initialized or not ir.is_connected:
                print("[Bridge] Waiting for iRacing session…")
                ir.startup()
                time.sleep(2)
                continue

            ir.freeze_var_buffer_latest()

            current_lap   = ir['Lap']               or 0
            fuel_level    = ir['FuelLevel']          or 0.0
            session_time  = ir['SessionTime']        or 0.0
            is_on_track   = ir['IsOnTrack']          or False
            lap_completed = ir['LapCompleted']       or 0
            lap_last_time = ir['LapLastLapTime']     or 0.0

            # Convert fuel to gallons if needed
            if fuel_unit == 'l':
                fuel_gal = fuel_level * 0.264172
            else:
                fuel_gal = fuel_level

            now = time.time()

            # ── Push telemetry state ─────────────────────────────────────────
            if now - last_telemetry_t >= TELEMETRY_EVERY:
                payload = {
                    'current_lap':     current_lap,
                    'fuel_level':      round(fuel_gal, 3),
                    'last_lap_time_s': round(lap_last_time, 3) if lap_last_time > 0 else None,
                    'session_time_s':  round(session_time, 1),
                    'is_on_track':     is_on_track,
                }
                try:
                    r = requests.post(
                        f"{base}/api/plans/{plan_id}/telemetry",
                        json=payload, timeout=5
                    )
                    if r.ok:
                        print(f"[Telemetry] Lap {current_lap} | Fuel {fuel_gal:.2f} gal"
                              f" | OnTrack: {is_on_track}")
                    else:
                        print(f"[Telemetry] Server error {r.status_code}: {r.text[:80]}")
                except requests.RequestException as e:
                    print(f"[Telemetry] Connection error: {e}")
                last_telemetry_t = now

            # ── Log completed lap ────────────────────────────────────────────
            if (lap_completed > 0
                    and lap_completed != last_lap_logged
                    and lap_last_time > 0
                    and lap_last_time < 600):   # sanity: < 10 min lap time

                print(f"[Lap] #{lap_completed} — {lap_last_time:.3f}s")
                last_lap_time_s = lap_last_time

                lap_payload = {
                    'lap_num':     lap_completed,
                    'time_s':      round(lap_last_time, 3),
                    'driver_name': driver or None,
                    'note':        'telemetry',
                }
                try:
                    r = requests.post(
                        f"{base}/api/plans/{plan_id}/laps",
                        json=lap_payload, timeout=5
                    )
                    if r.ok:
                        print(f"[Lap] Logged lap {lap_completed}: {lap_last_time:.3f}s ✓")
                    else:
                        print(f"[Lap] Failed to log: {r.status_code} {r.text[:80]}")
                except requests.RequestException as e:
                    print(f"[Lap] Connection error: {e}")

                last_lap_logged = lap_completed

        except Exception as e:
            print(f"[Bridge] Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    main()
