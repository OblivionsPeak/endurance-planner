"""
Endurance Race Planner — iRacing Telemetry Bridge
==================================================
Teammates: just double-click run_bridge.bat (or run_bridge.sh on Mac/Linux).
Python 3.8+ is the only requirement — the script installs everything else itself.

If you don't have Python:  https://www.python.org/downloads/
(tick "Add Python to PATH" during install)
"""

import json
import os
import subprocess
import sys

# ── Auto-install missing packages before anything else ──────────────────────
def _ensure(package, import_name=None):
    import_name = import_name or package
    try:
        __import__(import_name)
    except ImportError:
        print(f'Installing {package}…')
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', package, '-q'])

_ensure('requests')
_ensure('pyirsdk', 'irsdk')
# ── Now safe to import ───────────────────────────────────────────────────────

import threading
import time
import tkinter as tk
from tkinter import ttk, scrolledtext

import requests

try:
    import irsdk
    IRSDK_AVAILABLE = True
except ImportError:
    IRSDK_AVAILABLE = False

# ---------------------------------------------------------------------------
# Config persistence  (saved next to the exe / script)
# ---------------------------------------------------------------------------
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'bridge_config.json')

DEFAULTS = {
    'server_url':  'https://your-app.railway.app',
    'plan_id':     '',
    'driver_name': '',
    'fuel_unit':   'gal',
}

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            c = json.load(f)
            return {**DEFAULTS, **c}
    except Exception:
        return dict(DEFAULTS)

def save_config(cfg):
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Bridge logic (runs in a background thread)
# ---------------------------------------------------------------------------
POLL_INTERVAL        = 0.5
TELEMETRY_EVERY      = 1.0
COMPETITOR_SYNC_EVERY = 5.0

class BridgeThread(threading.Thread):
    def __init__(self, cfg, log_fn, status_fn):
        super().__init__(daemon=True)
        self.cfg       = cfg
        self.log       = log_fn      # callback(text)
        self.set_status = status_fn  # callback('connected'|'connecting'|'stopped'|'error')
        self._stop_evt = threading.Event()

    def stop(self):
        self._stop_evt.set()

    def run(self):
        base      = self.cfg['server_url'].rstrip('/')
        plan_id   = self.cfg['plan_id']
        driver    = self.cfg['driver_name'].strip()
        fuel_unit = self.cfg['fuel_unit']

        if not IRSDK_AVAILABLE:
            self.log('ERROR: pyirsdk not installed.\nRun: pip install pyirsdk requests')
            self.set_status('error')
            return

        ir = irsdk.IRSDK()
        ir.startup()

        self.log(f'Connecting to iRacing…')
        self.log(f'Server : {base}')
        self.log(f'Plan ID: {plan_id}  |  Driver: {driver or "(any)"}')
        self.set_status('connecting')

        last_lap_logged       = 0
        last_telemetry_t      = 0.0
        last_competitor_sync_t = 0.0
        session_info_sent     = False

        while not self._stop_evt.is_set():
            try:
                if not ir.is_initialized or not ir.is_connected:
                    self.set_status('connecting')
                    self.log('Waiting for iRacing session…')
                    ir.startup()
                    time.sleep(2)
                    continue

                ir.freeze_var_buffer_latest()
                current_lap   = ir['Lap']           or 0
                fuel_raw      = ir['FuelLevel']      or 0.0
                session_time  = ir['SessionTime']    or 0.0
                is_on_track   = ir['IsOnTrack']      or False
                lap_completed = ir['LapCompleted']   or 0
                lap_last_time = ir['LapLastLapTime'] or 0.0

                fuel_gal = fuel_raw * 0.264172 if fuel_unit == 'l' else fuel_raw
                now      = time.time()

                # ── Telemetry push ──────────────────────────────────────
                if now - last_telemetry_t >= TELEMETRY_EVERY:
                    payload = {
                        'current_lap':     current_lap,
                        'fuel_level':      round(fuel_gal, 3),
                        'last_lap_time_s': round(lap_last_time, 3) if lap_last_time > 0 else None,
                        'session_time_s':  round(session_time, 1),
                        'is_on_track':     is_on_track,
                    }
                    # Include session info once on first successful push
                    if not session_info_sent:
                        try:
                            wi = ir['WeekendInfo']
                            if wi:
                                payload['session_info'] = {
                                    'track_name':   wi.get('TrackName', ''),
                                    'series_name':  wi.get('SeriesName', ''),
                                    'session_name': wi.get('EventType', ''),
                                    'track_length': wi.get('TrackLength', ''),
                                }
                        except Exception:
                            pass
                    try:
                        r = requests.post(f'{base}/api/plans/{plan_id}/telemetry',
                                          json=payload, timeout=5)
                        if r.ok:
                            self.set_status('connected')
                            if not session_info_sent and payload.get('session_info'):
                                self.log(f'📍 Session: {payload["session_info"].get("track_name","?")} — {payload["session_info"].get("series_name","?")}')
                                session_info_sent = True
                            mins = int(session_time // 60)
                            secs = session_time % 60
                            self.log(
                                f'Lap {current_lap:>4}  |  '
                                f'Fuel {fuel_gal:>5.2f} gal  |  '
                                f'Session {mins:02d}:{secs:04.1f}'
                            )
                        else:
                            self.log(f'Server error {r.status_code}: {r.text[:60]}')
                            self.set_status('error')
                    except requests.RequestException as e:
                        self.log(f'Connection error: {e}')
                        self.set_status('error')
                    last_telemetry_t = now

                # ── Competitor sync ─────────────────────────────────────
                if now - last_competitor_sync_t >= COMPETITOR_SYNC_EVERY:
                    try:
                        drivers_info = ir['DriverInfo']
                        car_idx_lap  = ir['CarIdxLap']
                        car_idx_pit  = ir['CarIdxOnPitRoad']
                        if drivers_info and car_idx_lap is not None:
                            idx_to_num = {
                                d['CarIdx']: str(d.get('CarNumber', '')).strip()
                                for d in drivers_info.get('Drivers', [])
                                if d.get('CarNumber')
                            }
                            competitors = []
                            for idx, car_num in idx_to_num.items():
                                if idx < len(car_idx_lap):
                                    competitors.append({
                                        'car_num':     car_num,
                                        'current_lap': int(car_idx_lap[idx] or 0),
                                        'on_pit_road': bool(car_idx_pit[idx]) if car_idx_pit and idx < len(car_idx_pit) else False,
                                    })
                            if competitors:
                                requests.post(
                                    f'{base}/api/plans/{plan_id}/competitors/sync',
                                    json={'competitors': competitors},
                                    timeout=5,
                                )
                    except Exception:
                        pass
                    last_competitor_sync_t = now

                # ── Lap completed ───────────────────────────────────────
                if (lap_completed > 0
                        and lap_completed != last_lap_logged
                        and 0 < lap_last_time < 600):
                    m   = int(lap_last_time // 60)
                    s   = lap_last_time % 60
                    self.log(f'▶ LAP {lap_completed}  {m}:{s:06.3f}  — logging…')
                    try:
                        r = requests.post(
                            f'{base}/api/plans/{plan_id}/laps',
                            json={
                                'lap_num':     lap_completed,
                                'time_s':      round(lap_last_time, 3),
                                'driver_name': driver or None,
                                'note':        'telemetry',
                            },
                            timeout=5,
                        )
                        self.log(f'  → {"✓ logged" if r.ok else "✗ failed " + str(r.status_code)}')
                    except requests.RequestException as e:
                        self.log(f'  → ✗ {e}')
                    last_lap_logged = lap_completed

            except Exception as e:
                self.log(f'Error: {e}')

            self._stop_evt.wait(POLL_INTERVAL)

        self.log('Bridge stopped.')
        self.set_status('stopped')


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------
BG      = '#07101f'
BG2     = '#0c1830'
BG3     = '#122040'
BORDER  = '#1a2f52'
ACCENT  = '#c8192e'
GREEN   = '#3ecf8e'
YELLOW  = '#f5c542'
TEXT    = '#edf1ff'
DIM     = '#6e85b0'

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('Endurance Race Planner — Telemetry Bridge')
        self.configure(bg=BG)
        self.resizable(True, True)
        self.minsize(500, 460)

        cfg = load_config()
        self._bridge: BridgeThread | None = None

        # ── Style ────────────────────────────────────────────────────────
        style = ttk.Style(self)
        style.theme_use('clam')
        style.configure('TLabel',      background=BG,  foreground=TEXT, font=('Segoe UI', 9))
        style.configure('TFrame',      background=BG)
        style.configure('TLabelframe', background=BG2, foreground=DIM,  relief='flat')
        style.configure('TLabelframe.Label', background=BG2, foreground=DIM, font=('Segoe UI', 8, 'bold'))
        style.configure('TEntry',      fieldbackground=BG3, foreground=TEXT, insertcolor=TEXT,
                        bordercolor=BORDER, relief='flat')
        style.configure('TCombobox',   fieldbackground=BG3, foreground=TEXT, selectbackground=BG3)
        style.map('TEntry',    bordercolor=[('focus', ACCENT)])
        style.map('TCombobox', fieldbackground=[('readonly', BG3)])
        style.configure('Start.TButton', background=ACCENT, foreground='white',
                        font=('Segoe UI', 10, 'bold'), relief='flat', padding=(16, 8))
        style.map('Start.TButton', background=[('active', '#a01020')])
        style.configure('Stop.TButton', background=BG3, foreground=YELLOW,
                        font=('Segoe UI', 10, 'bold'), relief='flat', padding=(16, 8))
        style.map('Stop.TButton', background=[('active', '#1a2f52')])

        # ── Layout ───────────────────────────────────────────────────────
        pad = dict(padx=12, pady=5)

        # Header
        hdr = ttk.Frame(self)
        hdr.pack(fill='x', pady=(14, 8), padx=14)
        tk.Label(hdr, text='⬡', bg=BG, fg=ACCENT, font=('Segoe UI', 18)).pack(side='left')
        tk.Label(hdr, text='  ENDURANCE RACE PLANNER', bg=BG, fg=TEXT,
                 font=('Segoe UI', 12, 'bold')).pack(side='left')
        tk.Label(hdr, text='Telemetry Bridge', bg=BG, fg=DIM,
                 font=('Segoe UI', 9)).pack(side='left', padx=(8, 0))

        # Config fields
        frm = ttk.LabelFrame(self, text='CONNECTION SETTINGS', padding=10)
        frm.pack(fill='x', padx=14, pady=4)
        frm.columnconfigure(1, weight=1)

        def field(row, label, var, placeholder=''):
            ttk.Label(frm, text=label).grid(row=row, column=0, sticky='w', pady=3, padx=(0, 10))
            e = ttk.Entry(frm, textvariable=var)
            e.grid(row=row, column=1, sticky='ew', pady=3)
            if not var.get() and placeholder:
                e.insert(0, placeholder)
                e.config(foreground=DIM)
                def on_focus_in(event, entry=e, pvar=var, ph=placeholder):
                    if entry.get() == ph:
                        entry.delete(0, 'end')
                        entry.config(foreground=TEXT)
                def on_focus_out(event, entry=e, pvar=var, ph=placeholder):
                    if not entry.get():
                        entry.insert(0, ph)
                        entry.config(foreground=DIM)
                e.bind('<FocusIn>',  on_focus_in)
                e.bind('<FocusOut>', on_focus_out)
            return e

        self.v_url    = tk.StringVar(value=cfg['server_url'])
        self.v_plan   = tk.StringVar(value=cfg['plan_id'])
        self.v_driver = tk.StringVar(value=cfg['driver_name'])
        self.v_fuel   = tk.StringVar(value=cfg['fuel_unit'])

        field(0, 'Server URL', self.v_url)
        field(1, 'Plan ID',    self.v_plan,   placeholder='e.g. 42')
        field(2, 'Driver Name', self.v_driver, placeholder='As entered in the plan')

        ttk.Label(frm, text='Fuel Unit').grid(row=3, column=0, sticky='w', pady=3, padx=(0, 10))
        cb = ttk.Combobox(frm, textvariable=self.v_fuel, values=['gal', 'l'],
                          state='readonly', width=6)
        cb.grid(row=3, column=1, sticky='w', pady=3)

        # Status bar
        sf = ttk.Frame(self)
        sf.pack(fill='x', padx=14, pady=(6, 2))
        self.status_dot   = tk.Label(sf, text='●', bg=BG, fg=BORDER, font=('Segoe UI', 11))
        self.status_dot.pack(side='left')
        self.status_label = tk.Label(sf, text='Not connected', bg=BG, fg=DIM,
                                     font=('Segoe UI', 9))
        self.status_label.pack(side='left', padx=(4, 0))

        # Buttons
        bf = ttk.Frame(self)
        bf.pack(fill='x', padx=14, pady=6)
        self.start_btn = ttk.Button(bf, text='▶  Start Bridge', style='Start.TButton',
                                    command=self.start_bridge)
        self.start_btn.pack(side='left', padx=(0, 8))
        self.stop_btn = ttk.Button(bf, text='■  Stop', style='Stop.TButton',
                                   command=self.stop_bridge, state='disabled')
        self.stop_btn.pack(side='left')
        tk.Label(bf, text='iRacing must be running before starting.',
                 bg=BG, fg=DIM, font=('Segoe UI', 8)).pack(side='right')

        # Log
        lf = ttk.LabelFrame(self, text='LOG', padding=6)
        lf.pack(fill='both', expand=True, padx=14, pady=(4, 14))
        self.log_box = scrolledtext.ScrolledText(
            lf, bg=BG3, fg=TEXT, insertbackground=TEXT,
            font=('Consolas', 8), relief='flat', bd=0,
            state='disabled', wrap='word',
        )
        self.log_box.pack(fill='both', expand=True)

        if not IRSDK_AVAILABLE:
            self.log('⚠  pyirsdk not installed.\n'
                     '   Run in a terminal: pip install pyirsdk requests\n'
                     '   Then restart this app.')

        self.protocol('WM_DELETE_WINDOW', self.on_close)

    # ── Bridge control ────────────────────────────────────────────────────
    def start_bridge(self):
        url    = self.v_url.get().strip()
        plan   = self.v_plan.get().strip()
        driver = self.v_driver.get().strip()
        fuel   = self.v_fuel.get()

        if not url or not plan:
            self.log('⚠  Please enter Server URL and Plan ID.')
            return

        cfg = {'server_url': url, 'plan_id': plan, 'driver_name': driver, 'fuel_unit': fuel}
        save_config(cfg)

        self.log(f'─── Starting bridge ─── {time.strftime("%H:%M:%S")} ───')
        self._bridge = BridgeThread(cfg, self.log, self.set_status)
        self._bridge.start()

        self.start_btn.config(state='disabled')
        self.stop_btn.config(state='normal')

    def stop_bridge(self):
        if self._bridge:
            self._bridge.stop()
            self._bridge = None
        self.start_btn.config(state='normal')
        self.stop_btn.config(state='disabled')
        self.set_status('stopped')

    def set_status(self, status):
        colors = {
            'connecting': (YELLOW,  'Connecting to iRacing…'),
            'connected':  (GREEN,   'Connected — data flowing'),
            'error':      (ACCENT,  'Connection error — retrying'),
            'stopped':    (BORDER,  'Stopped'),
        }
        color, text = colors.get(status, (BORDER, status))
        self.after(0, lambda: (
            self.status_dot.config(fg=color),
            self.status_label.config(text=text, fg=color),
        ))

    def log(self, msg):
        def _append():
            self.log_box.config(state='normal')
            self.log_box.insert('end', msg + '\n')
            self.log_box.see('end')
            # Keep last 500 lines
            lines = int(self.log_box.index('end-1c').split('.')[0])
            if lines > 500:
                self.log_box.delete('1.0', f'{lines - 500}.0')
            self.log_box.config(state='disabled')
        self.after(0, _append)

    def on_close(self):
        self.stop_bridge()
        self.destroy()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    app = App()
    app.mainloop()
