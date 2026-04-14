"""
Endurance Race Planner — iRacing Telemetry Agent
================================================
Runs locally on Windows alongside iRacing.
Auto-posts lap times and tire data to the Endurance Race Planner app.

Double-click to run, or build to .exe with:  build_telemetry_exe.bat
"""

import os
import sys
import json
import time
import queue
import threading
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
from datetime import datetime

import requests

# Optional — only needed when iRacing is running
try:
    import irsdk
    IRSDK_AVAILABLE = True
except ImportError:
    IRSDK_AVAILABLE = False

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'telemetry_config.json')

DEFAULT_CONFIG = {
    'server_url': 'https://YOUR-APP.railway.app',
    'plan_id':    '',
    'driver_name': '',
}


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            # Fill missing keys with defaults
            for k, v in DEFAULT_CONFIG.items():
                cfg.setdefault(k, v)
            return cfg
        except Exception:
            pass
    return dict(DEFAULT_CONFIG)


def save_config(cfg):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)


# ---------------------------------------------------------------------------
# Telemetry core (runs in background thread)
# ---------------------------------------------------------------------------

class TelemetryCore:
    POLL_INTERVAL = 0.25   # seconds between iRacing reads

    def __init__(self, server_url, plan_id, driver_name_override, log_fn):
        self.server      = server_url.rstrip('/')
        self.plan_id     = int(plan_id)
        self.driver_override = driver_name_override.strip() if driver_name_override else None
        self.log         = log_fn        # callable(msg, tag='') → queues message for UI

        self._stop       = threading.Event()
        self.ir          = None
        self.plan        = None
        self.drivers     = []
        self.stints      = []

        self.last_lap    = None
        self.was_on_pit  = False

    # ------------------------------------------------------------------
    # Control
    # ------------------------------------------------------------------

    def stop(self):
        self._stop.set()

    def run(self):
        if not IRSDK_AVAILABLE:
            self.log("ERROR: pyirsdk is not installed. Run setup_telemetry.bat first.", 'error')
            return

        if not self._load_plan():
            return

        self.ir = irsdk.IRSDK()
        self.log("Waiting for iRacing to start…", 'info')

        while not self._stop.is_set():
            if not self.ir.is_initialized:
                if self.ir.startup():
                    self.log("iRacing connected!", 'ok')
                else:
                    time.sleep(2)
                    continue

            if not self.ir.is_connected:
                self.log("iRacing disconnected. Waiting…", 'warn')
                self.ir.shutdown()
                time.sleep(2)
                continue

            self.ir.freeze_var_buffer_latest()
            self._tick()
            time.sleep(self.POLL_INTERVAL)

        if self.ir.is_initialized:
            self.ir.shutdown()
        self.log("Agent stopped.", 'info')

    # ------------------------------------------------------------------
    # Plan data
    # ------------------------------------------------------------------

    def _load_plan(self):
        self.log(f"Loading plan {self.plan_id} from {self.server}…")
        try:
            r = requests.get(f"{self.server}/api/plans/{self.plan_id}", timeout=10)
            r.raise_for_status()
            self.plan    = r.json()
            self.drivers = self.plan.get('drivers', [])
            self.stints  = self.plan.get('stints', [])
            self.log(f"Plan loaded: {self.plan['name']}", 'ok')
            self.log(f"  Drivers : {', '.join(d['name'] for d in self.drivers)}")
            self.log(f"  Stints  : {len(self.stints)}")
            return True
        except requests.HTTPError as e:
            self.log(f"ERROR: Plan {self.plan_id} not found ({e}). Check the Plan ID.", 'error')
        except requests.ConnectionError:
            self.log(f"ERROR: Cannot reach {self.server}. Check the Server URL.", 'error')
        except Exception as e:
            self.log(f"ERROR loading plan: {e}", 'error')
        return False

    # ------------------------------------------------------------------
    # Per-tick iRacing processing
    # ------------------------------------------------------------------

    def _tick(self):
        try:
            lap_count = self.ir['Lap']
            on_pit    = bool(self.ir['OnPitRoad'])

            if lap_count is None:
                return

            # Lap completed
            if self.last_lap is not None and lap_count > self.last_lap:
                completed = self.last_lap
                lap_time  = self.ir['LapLastLapTime']

                if lap_time and lap_time > 0:
                    driver_name = self._resolve_iracing_name()
                    note = 'telemetry'
                    if self.was_on_pit:
                        note = 'out-lap'
                    elif on_pit:
                        note = 'in-lap'
                    self._post_lap(completed, lap_time, driver_name, note)

            self.last_lap = lap_count

            # Pit entry: capture outgoing tire wear
            if not self.was_on_pit and on_pit:
                self.log(f"Pit IN detected at lap {lap_count}", 'info')
                wear = self._read_tire_wear()
                stint = self._stint_for_lap(lap_count)
                if stint and wear is not None:
                    self._post_tire(stint['id'], wear_pct=wear)

            # Pit exit: new tires fitted, reset wear
            elif self.was_on_pit and not on_pit:
                self.log(f"Pit OUT detected at lap {lap_count}", 'info')
                stint = self._stint_for_lap(lap_count)
                if stint:
                    self._post_tire(stint['id'], wear_pct=0, age_laps=0)

            self.was_on_pit = on_pit

        except Exception as e:
            self.log(f"Tick error: {e}", 'warn')

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _resolve_iracing_name(self):
        """Return driver name to send: override → iRacing username → empty."""
        if self.driver_override:
            return self.driver_override
        try:
            car_idx = self.ir['PlayerCarIdx']
            return self.ir['DriverInfo']['Drivers'][car_idx]['UserName']
        except Exception:
            return ''

    def _stint_for_lap(self, lap):
        for s in self.stints:
            if s['start_lap'] <= lap <= s['end_lap']:
                return s
        return None

    def _read_tire_wear(self):
        """Average wear % across all four corners (0 = new, 100 = gone)."""
        try:
            total, count = 0.0, 0
            for corner in [
                ('TireLFwearL', 'TireLFwearM', 'TireLFwearR'),
                ('TireRFwearL', 'TireRFwearM', 'TireRFwearR'),
                ('TireLRwearL', 'TireLRwearM', 'TireLRwearR'),
                ('TireRRwearL', 'TireRRwearM', 'TireRRwearR'),
            ]:
                vals = [self.ir[c] for c in corner if self.ir[c] is not None]
                if vals:
                    total += sum(vals) / len(vals)
                    count += 1
            if count:
                avg_remaining = total / count   # 1.0 = new, 0.0 = worn
                return round((1 - avg_remaining) * 100, 1)
        except Exception as e:
            self.log(f"Tire wear read error: {e}", 'warn')
        return None

    # ------------------------------------------------------------------
    # API calls
    # ------------------------------------------------------------------

    def _post_lap(self, lap_num, time_s, driver_name, note):
        m, s = divmod(time_s, 60)
        self.log(f"Lap {lap_num:3d}  {int(m)}:{s:06.3f}  driver={driver_name or '?'}")
        payload = {
            'lap_num':     lap_num,
            'time_s':      round(time_s, 3),
            'driver_name': driver_name,
            'note':        note,
        }
        try:
            r = requests.post(
                f"{self.server}/api/plans/{self.plan_id}/laps",
                json=payload, timeout=5
            )
            if r.status_code == 201:
                self.log(f"  ✓ Lap {lap_num} saved", 'ok')
            else:
                self.log(f"  ✗ Lap POST failed ({r.status_code})", 'error')
        except Exception as e:
            self.log(f"  ✗ Network error: {e}", 'error')

    def _post_tire(self, stint_id, wear_pct=None, age_laps=None):
        payload = {}
        if wear_pct is not None:
            payload['tire_wear_pct'] = wear_pct
        if age_laps is not None:
            payload['tire_age_laps'] = age_laps
        if not payload:
            return
        self.log(f"Tire update  stint={stint_id}  {payload}")
        try:
            r = requests.patch(
                f"{self.server}/api/plans/{self.plan_id}/stints/{stint_id}",
                json=payload, timeout=5
            )
            if r.ok:
                self.log(f"  ✓ Tire data saved (stint {stint_id})", 'ok')
            else:
                self.log(f"  ✗ Tire PATCH failed ({r.status_code})", 'error')
        except Exception as e:
            self.log(f"  ✗ Network error: {e}", 'error')


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

DARK_BG   = '#1a1a2e'
CARD_BG   = '#16213e'
ACCENT    = '#4fc3f7'
TEXT      = '#e0e0e0'
TEXT_DIM  = '#888'
GREEN     = '#81c784'
RED       = '#e57373'
YELLOW    = '#ffb74d'
FONT_MONO = ('Consolas', 9)
FONT_UI   = ('Segoe UI', 10)
FONT_BOLD = ('Segoe UI', 10, 'bold')


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Endurance Telemetry Agent")
        self.configure(bg=DARK_BG)
        self.resizable(True, True)
        self.minsize(540, 480)

        self._cfg      = load_config()
        self._queue    = queue.Queue()
        self._thread   = None
        self._core     = None
        self._running  = False

        self._build_ui()
        self._apply_config()
        self._poll_queue()

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        pad = dict(padx=12, pady=6)

        # Header
        hdr = tk.Frame(self, bg=ACCENT, height=4)
        hdr.pack(fill='x')

        title_frame = tk.Frame(self, bg=DARK_BG)
        title_frame.pack(fill='x', padx=16, pady=(10, 4))
        tk.Label(title_frame, text="⬡ ENDURANCE TELEMETRY AGENT",
                 font=('Segoe UI', 12, 'bold'), bg=DARK_BG, fg=ACCENT).pack(side='left')

        # Config card
        card = tk.Frame(self, bg=CARD_BG, bd=0)
        card.pack(fill='x', padx=16, pady=(4, 8))

        def field(parent, label, var, placeholder='', width=38):
            row = tk.Frame(parent, bg=CARD_BG)
            row.pack(fill='x', padx=10, pady=4)
            tk.Label(row, text=label, width=14, anchor='w',
                     font=FONT_UI, bg=CARD_BG, fg=TEXT_DIM).pack(side='left')
            e = tk.Entry(row, textvariable=var, width=width,
                         font=FONT_UI, bg='#0f3460', fg=TEXT,
                         insertbackground=ACCENT, relief='flat',
                         highlightthickness=1, highlightbackground='#333',
                         highlightcolor=ACCENT)
            e.pack(side='left', ipady=4, padx=(0, 4))
            if placeholder and not var.get():
                e.insert(0, placeholder)
                e.config(fg=TEXT_DIM)
                def on_focus_in(event, entry=e, ph=placeholder, v=var):
                    if entry.get() == ph:
                        entry.delete(0, 'end')
                        entry.config(fg=TEXT)
                def on_focus_out(event, entry=e, ph=placeholder, v=var):
                    if not entry.get():
                        entry.insert(0, ph)
                        entry.config(fg=TEXT_DIM)
                        v.set('')
                e.bind('<FocusIn>', on_focus_in)
                e.bind('<FocusOut>', on_focus_out)
            return e

        self._var_server = tk.StringVar()
        self._var_plan   = tk.StringVar()
        self._var_driver = tk.StringVar()

        tk.Label(card, text="Connection", font=FONT_BOLD,
                 bg=CARD_BG, fg=ACCENT).pack(anchor='w', padx=10, pady=(8, 0))

        field(card, "Server URL",  self._var_server)
        field(card, "Plan ID",     self._var_plan,   placeholder='e.g.  3')
        field(card, "Your Name",   self._var_driver,
              placeholder='Leave blank to auto-detect from iRacing')

        # Status bar
        status_frame = tk.Frame(self, bg=DARK_BG)
        status_frame.pack(fill='x', padx=16, pady=(0, 6))

        self._status_dot   = tk.Label(status_frame, text='●', font=('Segoe UI', 14),
                                      bg=DARK_BG, fg=TEXT_DIM)
        self._status_dot.pack(side='left')
        self._status_label = tk.Label(status_frame, text='Stopped',
                                      font=FONT_UI, bg=DARK_BG, fg=TEXT_DIM)
        self._status_label.pack(side='left', padx=(4, 0))

        # Start / Stop button
        self._btn = tk.Button(
            self, text="▶  Start Tracking",
            font=('Segoe UI', 11, 'bold'),
            bg=GREEN, fg='#1a1a2e', activebackground='#66bb6a',
            relief='flat', cursor='hand2', bd=0,
            command=self._toggle
        )
        self._btn.pack(fill='x', padx=16, pady=(0, 8), ipady=8)

        # Log area
        log_frame = tk.Frame(self, bg=DARK_BG)
        log_frame.pack(fill='both', expand=True, padx=16, pady=(0, 12))

        tk.Label(log_frame, text="Activity Log", font=FONT_BOLD,
                 bg=DARK_BG, fg=TEXT_DIM).pack(anchor='w', pady=(0, 4))

        self._log_box = scrolledtext.ScrolledText(
            log_frame, font=FONT_MONO, bg='#0a0a1a', fg=TEXT,
            relief='flat', wrap='word', state='disabled',
            highlightthickness=1, highlightbackground='#333'
        )
        self._log_box.pack(fill='both', expand=True)
        self._log_box.tag_config('ok',    foreground=GREEN)
        self._log_box.tag_config('error', foreground=RED)
        self._log_box.tag_config('warn',  foreground=YELLOW)
        self._log_box.tag_config('info',  foreground=ACCENT)
        self._log_box.tag_config('ts',    foreground=TEXT_DIM)

        # Footer
        tk.Label(self, text="Reads iRacing telemetry • Posts to Endurance Race Planner",
                 font=('Segoe UI', 8), bg=DARK_BG, fg=TEXT_DIM).pack(pady=(0, 6))

    def _apply_config(self):
        self._var_server.set(self._cfg.get('server_url', ''))
        self._var_plan.set(str(self._cfg.get('plan_id', '')))
        self._var_driver.set(self._cfg.get('driver_name', ''))

    # ------------------------------------------------------------------
    # Start / Stop
    # ------------------------------------------------------------------

    def _toggle(self):
        if self._running:
            self._stop()
        else:
            self._start()

    def _start(self):
        server = self._var_server.get().strip()
        plan   = self._var_plan.get().strip()
        driver = self._var_driver.get().strip()

        # Ignore placeholder text
        if driver.lower().startswith('leave blank'):
            driver = ''

        if not server or server == DEFAULT_CONFIG['server_url']:
            messagebox.showerror("Missing config", "Please enter the Server URL.")
            return
        if not plan or not plan.isdigit():
            messagebox.showerror("Missing config", "Please enter a valid Plan ID (number).")
            return

        # Save config
        self._cfg.update({'server_url': server, 'plan_id': plan, 'driver_name': driver})
        save_config(self._cfg)

        self._running = True
        self._btn.config(text="■  Stop Tracking", bg=RED, activebackground='#ef5350')
        self._set_status('Starting…', YELLOW)
        self._log_clear()

        self._core   = TelemetryCore(server, plan, driver, self._queue_log)
        self._thread = threading.Thread(target=self._core.run, daemon=True)
        self._thread.start()

    def _stop(self):
        if self._core:
            self._core.stop()
        self._running = False
        self._btn.config(text="▶  Start Tracking", bg=GREEN, activebackground='#66bb6a')
        self._set_status('Stopped', TEXT_DIM)

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def _queue_log(self, msg, tag=''):
        self._queue.put((msg, tag))

    def _poll_queue(self):
        try:
            while True:
                msg, tag = self._queue.get_nowait()
                self._append_log(msg, tag)
                # Update status dot from key messages
                if 'iRacing connected' in msg:
                    self._set_status('iRacing connected', GREEN)
                elif 'disconnected' in msg.lower() or 'Waiting' in msg:
                    self._set_status('Waiting for iRacing…', YELLOW)
                elif 'Plan loaded' in msg:
                    self._set_status('Plan loaded — waiting for iRacing…', ACCENT)
                elif 'stopped' in msg.lower():
                    self._set_status('Stopped', TEXT_DIM)
        except queue.Empty:
            pass
        self.after(100, self._poll_queue)

    def _append_log(self, msg, tag=''):
        ts = datetime.now().strftime('%H:%M:%S')
        self._log_box.config(state='normal')
        self._log_box.insert('end', f"[{ts}] ", 'ts')
        self._log_box.insert('end', msg + '\n', tag or '')
        self._log_box.see('end')
        self._log_box.config(state='disabled')

    def _log_clear(self):
        self._log_box.config(state='normal')
        self._log_box.delete('1.0', 'end')
        self._log_box.config(state='disabled')

    def _set_status(self, text, color):
        self._status_dot.config(fg=color)
        self._status_label.config(text=text, fg=color)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    app = App()
    app.mainloop()
