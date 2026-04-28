import os
import json
import math
import hashlib
import secrets
import psycopg2
import psycopg2.extras
from datetime import datetime
from itertools import permutations
from flask import Flask, render_template, request, jsonify, g, session
from flask_socketio import SocketIO, join_room
from dotenv import load_dotenv

load_dotenv()
# Required env vars: DATABASE_URL, SECRET_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', secrets.token_hex(32))
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')
DATABASE_URL = os.environ.get('DATABASE_URL')


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def _get_engineer_account(token: str):
    """Return engineer account row for a valid token, or None."""
    row = db_exec(
        """SELECT a.* FROM engineer_accounts a
           JOIN engineer_tokens t ON t.account_id = a.id
           WHERE t.token = %s""",
        (token,)
    ).fetchone()
    if row:
        # Update last_used
        db_exec("UPDATE engineer_tokens SET last_used=%s WHERE token=%s",
                (datetime.utcnow().isoformat(), token))
        db_commit()
    return dict(row) if row else None

FREE_QUERY_LIMIT = 50  # queries per day on free tier


def _current_user():
    uid = session.get('user_id')
    if not uid:
        return None
    row = db_exec("SELECT u.*, t.name AS team_name FROM users u JOIN teams t ON t.id=u.team_id WHERE u.id=%s", (uid,)).fetchone()
    return dict(row) if row else None

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    if '_database' not in g:
        g._database = psycopg2.connect(DATABASE_URL)
    return g._database


def db_exec(sql, args=()):
    """Return a RealDictCursor after executing sql. Caller must commit."""
    cur = get_db().cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql, args)
    return cur


def db_commit():
    get_db().commit()


@app.teardown_appcontext
def close_connection(exception):
    db = g.pop('_database', None)
    if db is not None:
        if exception:
            db.rollback()
        db.close()


def init_db():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS race_plans (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            config      TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS drivers (
            id          SERIAL PRIMARY KEY,
            plan_id     INTEGER NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            max_hours   FLOAT NOT NULL DEFAULT 2.0,
            color       TEXT NOT NULL DEFAULT '#4fc3f7'
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stints (
            id             SERIAL PRIMARY KEY,
            plan_id        INTEGER NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
            stint_num      INTEGER NOT NULL,
            driver_id      INTEGER REFERENCES drivers(id),
            start_lap      INTEGER NOT NULL,
            end_lap        INTEGER NOT NULL,
            pit_lap        INTEGER,
            fuel_load      FLOAT NOT NULL,
            fuel_mode      TEXT NOT NULL DEFAULT 'normal',
            is_complete    INTEGER NOT NULL DEFAULT 0,
            actual_end_lap INTEGER
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS live_events (
            id          SERIAL PRIMARY KEY,
            plan_id     INTEGER NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
            lap         INTEGER NOT NULL,
            event_type  TEXT NOT NULL,
            note        TEXT,
            created_at  TEXT NOT NULL
        )
    """)
    # Tire data columns (added in migration — safe to run on existing DBs)
    cur.execute("ALTER TABLE drivers ADD COLUMN IF NOT EXISTS min_hours FLOAT DEFAULT 0")
    cur.execute("ALTER TABLE drivers ADD COLUMN IF NOT EXISTS target_lap_s FLOAT")
    cur.execute("ALTER TABLE drivers ADD COLUMN IF NOT EXISTS target_fpl FLOAT")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_compound TEXT")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_set TEXT")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_age_laps INTEGER")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_wear_pct FLOAT")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS actual_fuel_added FLOAT")
    cur.execute("ALTER TABLE race_plans ADD COLUMN IF NOT EXISTS telemetry_state TEXT")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS competitors (
            id            SERIAL PRIMARY KEY,
            plan_id       INTEGER NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
            car_num       TEXT NOT NULL,
            name          TEXT,
            laps_per_tank INTEGER NOT NULL DEFAULT 25,
            current_lap   INTEGER NOT NULL DEFAULT 0,
            color         TEXT NOT NULL DEFAULT '#ff8a65'
        )
    """)
    cur.execute("ALTER TABLE competitors ADD COLUMN IF NOT EXISTS on_pit_road INTEGER NOT NULL DEFAULT 0")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS teams (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            email         TEXT NOT NULL UNIQUE,
            display_name  TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL
        )
    """)
    cur.execute("ALTER TABLE race_plans ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id)")
    cur.execute("ALTER TABLE teams ADD COLUMN IF NOT EXISTS invite_code TEXT UNIQUE")
    # Back-fill invite codes for teams created before this column existed
    cur.execute("SELECT id FROM teams WHERE invite_code IS NULL")
    for row in cur.fetchall():
        code = secrets.token_hex(4).upper()
        cur.execute("UPDATE teams SET invite_code=%s WHERE id=%s", (code, row[0]))
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pit_stops (
            id           SERIAL PRIMARY KEY,
            plan_id      INTEGER NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
            entry_lap    INTEGER NOT NULL,
            entry_time_s FLOAT NOT NULL,
            exit_time_s  FLOAT,
            duration_s   FLOAT,
            logged_at    TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS lap_times (
            id          SERIAL PRIMARY KEY,
            plan_id     INTEGER NOT NULL REFERENCES race_plans(id) ON DELETE CASCADE,
            lap_num     INTEGER NOT NULL,
            driver_id   INTEGER REFERENCES drivers(id),
            time_s      FLOAT NOT NULL,
            note        TEXT,
            logged_at   TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS engineer_accounts (
            id            SERIAL PRIMARY KEY,
            email         TEXT NOT NULL UNIQUE,
            display_name  TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            queries_today INTEGER NOT NULL DEFAULT 0,
            query_date    TEXT,
            created_at    TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS engineer_tokens (
            token       TEXT PRIMARY KEY,
            account_id  INTEGER NOT NULL REFERENCES engineer_accounts(id) ON DELETE CASCADE,
            created_at  TEXT NOT NULL,
            last_used   TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS engineer_sessions (
            id                SERIAL PRIMARY KEY,
            account_id        INTEGER NOT NULL REFERENCES engineer_accounts(id) ON DELETE CASCADE,
            track_name        TEXT NOT NULL,
            car_name          TEXT,
            session_date      TEXT NOT NULL,
            race_duration_hrs FLOAT,
            total_laps        INTEGER,
            best_lap_s        FLOAT,
            avg_lap_s         FLOAT,
            avg_fpl_l         FLOAT,
            total_stints      INTEGER,
            started_at        TEXT NOT NULL,
            ended_at          TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS engineer_laps (
            id          SERIAL PRIMARY KEY,
            session_id  INTEGER NOT NULL REFERENCES engineer_sessions(id) ON DELETE CASCADE,
            lap_num     INTEGER NOT NULL,
            lap_time_s  FLOAT NOT NULL,
            fuel_used_l FLOAT,
            position    INTEGER,
            logged_at   TEXT NOT NULL
        )
    """)
    conn.commit()
    cur.close()
    conn.close()


# ---------------------------------------------------------------------------
# Strategy calculation engine
# ---------------------------------------------------------------------------

FUEL_MODE_MULTIPLIERS = {
    'normal': 1.0,
    'push':   1.08,   # 8% more fuel when pushing
    'save':   0.92,   # 8% less fuel when saving
}

SAFETY_BUFFER_LAPS = 1   # always keep at least 1 lap of fuel in reserve


def calculate_strategy(config: dict, drivers: list) -> list:
    """
    Core math: given race config and driver list, return a list of stint dicts.

    Each driver may supply target_lap_s and/or target_fpl to override the
    global config values for their specific stints.  The race is modelled in
    elapsed time so mixed lap-time drivers are handled correctly.

    config keys:
      race_duration_hrs, fuel_capacity_l, fuel_per_lap_l, lap_time_s,
      num_drivers, pit_loss_s, fuel_mode

    Returns list of:
      { stint_num, driver_name, driver_id, start_lap, end_lap, pit_lap,
        fuel_load, fuel_mode, laps_in_stint }
    """
    race_dur_s         = config['race_duration_hrs'] * 3600
    global_lap_s       = config['lap_time_s']
    fuel_capacity      = config['fuel_capacity_l']
    global_base_fpl    = config['fuel_per_lap_l']
    fuel_mode          = config.get('fuel_mode', 'normal')
    max_continuous_hrs = config.get('max_continuous_hrs', 2.5)

    multiplier   = FUEL_MODE_MULTIPLIERS.get(fuel_mode, 1.0)
    global_fpl   = global_base_fpl * multiplier

    # Global summary stats (used for meta display, fall back to global values)
    g_usable        = fuel_capacity - (global_fpl * SAFETY_BUFFER_LAPS)
    laps_per_tank   = int(math.floor(g_usable / global_fpl)) if global_fpl > 0 else 999
    g_fatigue_laps  = int(math.floor(max_continuous_hrs * 3600 / global_lap_s)) if global_lap_s > 0 else 999
    laps_per_stint  = min(laps_per_tank, g_fatigue_laps)

    stints       = []
    current_lap  = 1
    stint_num    = 1
    driver_index = 0
    total_time_s = 0.0
    n_drivers    = max(len(drivers), 1)

    while True:
        driver = (drivers[driver_index % n_drivers]
                  if drivers
                  else {'name': f'Driver {(driver_index % n_drivers) + 1}',
                        'id': None, 'color': '#4fc3f7',
                        'target_lap_s': None, 'target_fpl': None})

        # Per-driver lap time and fuel-per-lap (fall back to global if not set)
        raw_lap_s = driver.get('target_lap_s')
        d_lap_s   = float(raw_lap_s) if raw_lap_s and float(raw_lap_s) > 0 else global_lap_s

        raw_fpl   = driver.get('target_fpl')
        d_base_fpl = float(raw_fpl) if raw_fpl and float(raw_fpl) > 0 else global_base_fpl
        d_fpl      = d_base_fpl * multiplier

        # Per-driver stint limits
        d_usable        = fuel_capacity - (d_fpl * SAFETY_BUFFER_LAPS)
        d_laps_per_tank = int(math.floor(d_usable / d_fpl)) if d_fpl > 0 else 999
        d_fatigue_laps  = int(math.floor(max_continuous_hrs * 3600 / d_lap_s)) if d_lap_s > 0 else 999
        d_laps_per_stint = max(min(d_laps_per_tank, d_fatigue_laps), 1)

        # How many laps remain based on remaining race time at this driver's pace
        remaining_s          = race_dur_s - total_time_s
        remaining_laps_avail = int(math.floor(remaining_s / d_lap_s)) if d_lap_s > 0 else 0

        if remaining_laps_avail <= 0:
            break

        stint_laps = min(d_laps_per_stint, remaining_laps_avail)
        end_lap    = current_lap + stint_laps - 1
        is_last    = (remaining_laps_avail <= stint_laps)
        pit_lap    = end_lap if not is_last else None

        fuel_load = round(stint_laps * d_fpl + d_fpl * SAFETY_BUFFER_LAPS, 2)
        fuel_load = min(fuel_load, fuel_capacity)

        stints.append({
            'stint_num':     stint_num,
            'driver_name':   driver.get('name', ''),
            'driver_id':     driver.get('id'),
            'driver_color':  driver.get('color', '#4fc3f7'),
            'start_lap':     current_lap,
            'end_lap':       end_lap,
            'pit_lap':       pit_lap,
            'fuel_load':     fuel_load,
            'fuel_mode':     fuel_mode,
            'laps_in_stint': stint_laps,
            'is_last':       is_last,
        })

        total_time_s  += stint_laps * d_lap_s
        current_lap    = end_lap + 1
        stint_num     += 1
        driver_index  += 1

    total_laps = stints[-1]['end_lap'] if stints else 0

    return {
        'stints':         stints,
        'total_laps':     total_laps,
        'laps_per_tank':  laps_per_tank,
        'laps_per_stint': laps_per_stint,
        'fuel_per_lap':   round(global_fpl, 3),
        'total_stints':   len(stints),
        'pit_stops':      max(len(stints) - 1, 0),
    }


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html')


# ---------------------------------------------------------------------------
# Routes — Auth
# ---------------------------------------------------------------------------

@app.route('/auth/register', methods=['POST'])
def auth_register():
    """Create a new team, or join an existing team via invite_code."""
    data = request.get_json() or {}
    display_name = data.get('display_name', '').strip()
    email        = data.get('email', '').strip().lower()
    password     = data.get('password', '')
    invite_code  = data.get('invite_code', '').strip().upper()

    if not all([display_name, email, password]):
        return jsonify({'error': 'All fields are required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    existing = db_exec("SELECT id FROM users WHERE email=%s", (email,)).fetchone()
    if existing:
        return jsonify({'error': 'Email already registered'}), 409

    now = datetime.utcnow().isoformat()

    if invite_code:
        # Join existing team
        team_row = db_exec("SELECT id, name FROM teams WHERE invite_code=%s", (invite_code,)).fetchone()
        if not team_row:
            return jsonify({'error': 'Invite code not found — check with your team owner'}), 404
        team_id   = team_row['id']
        team_name = team_row['name']
    else:
        # Create new team
        team_name = data.get('team_name', '').strip()
        if not team_name:
            return jsonify({'error': 'Team name is required when creating a new team'}), 400
        code = secrets.token_hex(4).upper()   # 8-char hex invite code
        team_row = db_exec(
            "INSERT INTO teams (name, created_at, invite_code) VALUES (%s, %s, %s) RETURNING id",
            (team_name, now, code)
        ).fetchone()
        team_id = team_row['id']

    user_row = db_exec(
        "INSERT INTO users (team_id, email, display_name, password_hash, created_at) VALUES (%s,%s,%s,%s,%s) RETURNING id",
        (team_id, email, display_name, _hash_password(password), now)
    ).fetchone()
    db_commit()
    session['user_id'] = user_row['id']
    session['team_id'] = team_id
    return jsonify({'ok': True, 'team_name': team_name, 'display_name': display_name})


@app.route('/auth/login', methods=['POST'])
def auth_login():
    data = request.get_json() or {}
    email    = data.get('email', '').strip().lower()
    password = data.get('password', '')
    row = db_exec(
        "SELECT u.*, t.name AS team_name FROM users u JOIN teams t ON t.id=u.team_id WHERE u.email=%s AND u.password_hash=%s",
        (email, _hash_password(password))
    ).fetchone()
    if not row:
        return jsonify({'error': 'Invalid email or password'}), 401
    session['user_id'] = row['id']
    session['team_id'] = row['team_id']
    return jsonify({'ok': True, 'team_name': row['team_name'], 'display_name': row['display_name']})


@app.route('/auth/logout', methods=['POST'])
def auth_logout():
    session.clear()
    return jsonify({'ok': True})


@app.route('/auth/me', methods=['GET'])
def auth_me():
    user = _current_user()
    if not user:
        return jsonify({'logged_in': False})
    team = db_exec("SELECT invite_code FROM teams WHERE id=%s", (user['team_id'],)).fetchone()
    return jsonify({
        'logged_in':    True,
        'team_name':    user['team_name'],
        'display_name': user['display_name'],
        'invite_code':  team['invite_code'] if team else None,
    })


# ---------------------------------------------------------------------------
# Routes — Engineer backend proxy
# ---------------------------------------------------------------------------

@app.route('/engineer/register', methods=['POST'])
def engineer_register():
    data         = request.get_json() or {}
    email        = data.get('email', '').strip().lower()
    display_name = data.get('display_name', '').strip()
    password     = data.get('password', '')

    if not all([email, display_name, password]):
        return jsonify({'error': 'All fields required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    existing = db_exec(
        "SELECT id FROM engineer_accounts WHERE email=%s", (email,)
    ).fetchone()
    if existing:
        return jsonify({'error': 'Email already registered'}), 409

    now = datetime.utcnow().isoformat()
    account_row = db_exec(
        """INSERT INTO engineer_accounts
           (email, display_name, password_hash, created_at)
           VALUES (%s, %s, %s, %s) RETURNING id""",
        (email, display_name, _hash_password(password), now)
    ).fetchone()
    account_id = account_row['id']

    token = secrets.token_hex(32)
    db_exec(
        "INSERT INTO engineer_tokens (token, account_id, created_at) VALUES (%s, %s, %s)",
        (token, account_id, now)
    )
    db_commit()
    return jsonify({
        'ok': True,
        'token': token,
        'display_name': display_name,
        'queries_today': 0,
        'query_limit': FREE_QUERY_LIMIT,
    })


@app.route('/engineer/login', methods=['POST'])
def engineer_login():
    data     = request.get_json() or {}
    email    = data.get('email', '').strip().lower()
    password = data.get('password', '')

    row = db_exec(
        "SELECT * FROM engineer_accounts WHERE email=%s AND password_hash=%s",
        (email, _hash_password(password))
    ).fetchone()
    if not row:
        return jsonify({'error': 'Invalid email or password'}), 401

    account = dict(row)
    now     = datetime.utcnow().isoformat()
    token   = secrets.token_hex(32)
    db_exec(
        "INSERT INTO engineer_tokens (token, account_id, created_at) VALUES (%s, %s, %s)",
        (token, account['id'], now)
    )
    db_commit()

    # Reset daily count if it's a new day
    today = datetime.utcnow().strftime('%Y-%m-%d')
    if account.get('query_date') != today:
        db_exec(
            "UPDATE engineer_accounts SET queries_today=0, query_date=%s WHERE id=%s",
            (today, account['id'])
        )
        db_commit()
        account['queries_today'] = 0

    return jsonify({
        'ok': True,
        'token': token,
        'display_name': account['display_name'],
        'queries_today': account['queries_today'],
        'query_limit': FREE_QUERY_LIMIT,
    })


@app.route('/engineer/validate', methods=['POST'])
def engineer_validate():
    """Validate a stored token and return fresh account info."""
    data  = request.get_json() or {}
    token = data.get('token', '')
    if not token:
        return jsonify({'error': 'Token required'}), 401

    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid or expired token'}), 401

    return jsonify({
        'ok':           True,
        'display_name': account['display_name'],
        'queries_today': account['queries_today'],
        'query_limit':  FREE_QUERY_LIMIT,
    })


@app.route('/engineer/session/start', methods=['POST'])
def engineer_session_start():
    data       = request.get_json() or {}
    token      = data.get('token', '')
    track_name = data.get('track_name', 'Unknown')
    car_name   = data.get('car_name', '')
    duration   = data.get('race_duration_hrs', 0)

    if not token:
        return jsonify({'error': 'Token required'}), 401
    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid token'}), 401

    now = datetime.utcnow().isoformat()
    cur = db_exec(
        """INSERT INTO engineer_sessions
           (account_id, track_name, car_name, session_date, race_duration_hrs, started_at)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (account['id'], track_name, car_name,
         datetime.utcnow().strftime('%Y-%m-%d'), duration, now)
    )
    session_id = cur.fetchone()['id']
    db_commit()
    return jsonify({'ok': True, 'session_id': session_id})


@app.route('/engineer/session/lap', methods=['POST'])
def engineer_session_lap():
    data       = request.get_json() or {}
    token      = data.get('token', '')
    session_id = data.get('session_id')
    lap_num    = data.get('lap_num', 0)
    lap_time_s = data.get('lap_time_s', 0.0)
    fuel_used  = data.get('fuel_used_l')
    position   = data.get('position')

    if not token or not session_id:
        return jsonify({'error': 'Token and session_id required'}), 400
    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid token'}), 401

    now = datetime.utcnow().isoformat()
    db_exec(
        """INSERT INTO engineer_laps (session_id, lap_num, lap_time_s, fuel_used_l, position, logged_at)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (session_id, lap_num, lap_time_s, fuel_used, position, now)
    )
    db_commit()
    return jsonify({'ok': True})


@app.route('/engineer/session/end', methods=['POST'])
def engineer_session_end():
    data       = request.get_json() or {}
    token      = data.get('token', '')
    session_id = data.get('session_id')
    total_stints = data.get('total_stints', 0)

    if not token or not session_id:
        return jsonify({'error': 'Token and session_id required'}), 400
    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid token'}), 401

    # Compute stats from recorded laps
    cur = db_exec(
        "SELECT lap_time_s, fuel_used_l FROM engineer_laps WHERE session_id=%s",
        (session_id,)
    )
    laps = cur.fetchall()
    total_laps = len(laps)
    best_lap   = min((r['lap_time_s'] for r in laps), default=None)
    avg_lap    = (sum(r['lap_time_s'] for r in laps) / total_laps) if laps else None
    fuel_laps  = [r['fuel_used_l'] for r in laps if r['fuel_used_l']]
    avg_fpl    = (sum(fuel_laps) / len(fuel_laps)) if fuel_laps else None

    now = datetime.utcnow().isoformat()
    db_exec(
        """UPDATE engineer_sessions
           SET ended_at=%s, total_laps=%s, best_lap_s=%s, avg_lap_s=%s,
               avg_fpl_l=%s, total_stints=%s
           WHERE id=%s AND account_id=%s""",
        (now, total_laps, best_lap, avg_lap, avg_fpl, total_stints,
         session_id, account['id'])
    )
    db_commit()
    return jsonify({'ok': True})


@app.route('/engineer/history', methods=['GET'])
def engineer_history():
    token = request.args.get('token', '')
    if not token:
        return jsonify({'error': 'Token required'}), 401
    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid token'}), 401

    cur = db_exec(
        """SELECT track_name, car_name, session_date, best_lap_s, avg_lap_s,
                  avg_fpl_l, total_laps, total_stints, race_duration_hrs
           FROM engineer_sessions
           WHERE account_id=%s AND ended_at IS NOT NULL
           ORDER BY started_at DESC LIMIT 10""",
        (account['id'],)
    )
    sessions = [dict(r) for r in cur.fetchall()]
    return jsonify({'sessions': sessions})


@app.route('/engineer/track-stats', methods=['GET'])
def engineer_track_stats():
    """Return aggregate performance history for a specific track+car combination."""
    token    = request.args.get('token', '')
    track    = request.args.get('track', '').strip()
    car      = request.args.get('car', '').strip()
    if not token:
        return jsonify({'error': 'Token required'}), 401
    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid token'}), 401
    if not track:
        return jsonify({'error': 'track parameter required'}), 400

    # Match track loosely (case-insensitive contains) to handle iRacing name variations
    params = [account['id'], f'%{track}%']
    car_clause = ''
    if car:
        car_clause = ' AND LOWER(car_name) LIKE LOWER(%s)'
        params.append(f'%{car}%')

    cur = db_exec(
        f"""SELECT COUNT(*) AS session_count,
                   MIN(best_lap_s)  AS best_lap_s,
                   AVG(avg_lap_s)   AS avg_lap_s,
                   AVG(avg_fpl_l)   AS avg_fpl_l,
                   MAX(session_date) AS last_session_date,
                   SUM(total_laps)   AS total_laps
            FROM engineer_sessions
            WHERE account_id=%s
              AND LOWER(track_name) LIKE LOWER(%s)
              {car_clause}
              AND ended_at IS NOT NULL""",
        params
    )
    row = cur.fetchone()
    if not row or not row['session_count']:
        return jsonify({'found': False, 'session_count': 0})

    return jsonify({
        'found':            True,
        'session_count':    row['session_count'],
        'best_lap_s':       round(row['best_lap_s'], 3) if row['best_lap_s'] else None,
        'avg_lap_s':        round(row['avg_lap_s'], 3)  if row['avg_lap_s']  else None,
        'avg_fpl_l':        round(row['avg_fpl_l'], 3)  if row['avg_fpl_l']  else None,
        'last_session_date': str(row['last_session_date']) if row['last_session_date'] else None,
        'total_laps':       row['total_laps'] or 0,
    })


@app.route('/engineer/ask', methods=['POST'])
def engineer_ask():
    """
    Proxy AI queries to Claude Haiku on behalf of authenticated engineer users.
    Body: { token, system_prompt, question, messages? }
    When `messages` is provided and non-empty it is used as the full multi-turn
    conversation history (the final user turn must already be included by the
    client).  Otherwise falls back to single-turn using `question`.
    Returns: { answer, queries_today, query_limit }
    """
    data          = request.get_json() or {}
    token         = data.get('token', '')
    system_prompt = data.get('system_prompt', '')
    question      = data.get('question', '')
    messages      = data.get('messages', [])

    if not token:
        return jsonify({'error': 'Token required'}), 401
    if not messages and not question:
        return jsonify({'error': 'Question required'}), 400

    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid or expired token'}), 401

    # Check / reset daily quota
    today = datetime.utcnow().strftime('%Y-%m-%d')
    if account.get('query_date') != today:
        db_exec(
            "UPDATE engineer_accounts SET queries_today=0, query_date=%s WHERE id=%s",
            (today, account['id'])
        )
        db_commit()
        account['queries_today'] = 0

    if account['queries_today'] >= FREE_QUERY_LIMIT:
        return jsonify({
            'error': f"Daily limit of {FREE_QUERY_LIMIT} queries reached. Resets at midnight UTC.",
            'quota_exceeded': True,
        }), 429

    # Build message list: multi-turn if history provided, single-turn otherwise
    if not messages:
        messages = [{'role': 'user', 'content': question}]

    # Call Claude Haiku
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ.get('ANTHROPIC_API_KEY', ''))
        msg = client.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=300,
            system=system_prompt or 'You are a professional endurance racing engineer. Be concise — 1-3 sentences.',
            messages=messages,
        )
        answer = msg.content[0].text.strip()
    except Exception as e:
        return jsonify({'error': f'AI service error: {str(e)[:100]}'}), 500

    # Increment usage
    db_exec(
        "UPDATE engineer_accounts SET queries_today=queries_today+1, query_date=%s WHERE id=%s",
        (today, account['id'])
    )
    db_commit()

    return jsonify({
        'answer':       answer,
        'queries_today': account['queries_today'] + 1,
        'query_limit':  FREE_QUERY_LIMIT,
    })


@app.route('/engineer/coaching', methods=['POST'])
def engineer_coaching():
    """
    Proactive lap coaching — lightweight, doesn't count against daily quota.
    Body: {token, system_prompt, question}
    """
    data    = request.get_json() or {}
    token   = data.get('token', '')
    question = data.get('question', '')
    system_prompt = data.get('system_prompt', '')

    if not token:
        return jsonify({'error': 'Token required'}), 401
    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid or expired token'}), 401

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ.get('ANTHROPIC_API_KEY', ''))
        response = client.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=120,
            system=system_prompt,
            messages=[{'role': 'user', 'content': question}],
        )
        answer = response.content[0].text.strip()
        return jsonify({'answer': answer})
    except Exception as e:
        return jsonify({'error': str(e)[:100]}), 500


@app.route('/engineer/transcribe', methods=['POST'])
def engineer_transcribe():
    """
    Accept a WAV audio file upload, transcribe via OpenAI Whisper, return text.
    Form fields: token (str), audio (file)
    """
    token = request.form.get('token', '')
    if not token:
        return jsonify({'error': 'Token required'}), 401

    account = _get_engineer_account(token)
    if not account:
        return jsonify({'error': 'Invalid or expired token'}), 401

    audio_file = request.files.get('audio')
    if not audio_file:
        return jsonify({'error': 'Audio file required'}), 400

    api_key = os.environ.get('GROQ_API_KEY', '')
    if not api_key:
        return jsonify({'error': 'Server config error: GROQ_API_KEY not set'}), 500
    try:
        from groq import Groq
        client = Groq(api_key=api_key)
        audio_bytes = audio_file.read()
        transcript = client.audio.transcriptions.create(
            model='whisper-large-v3-turbo',
            file=('audio.wav', audio_bytes, 'audio/wav'),
            response_format='text',
        )
        return jsonify({'transcript': transcript.strip()})
    except Exception as e:
        return jsonify({'error': f'Transcription error: {str(e)[:120]}'}), 500


# ---------------------------------------------------------------------------
# Routes — Pit stop stopwatch
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/pit_stop/entry', methods=['POST'])
def pit_stop_entry(plan_id):
    data = request.get_json() or {}
    now = datetime.utcnow().isoformat()
    db_exec(
        "INSERT INTO pit_stops (plan_id, entry_lap, entry_time_s, logged_at) VALUES (%s,%s,%s,%s)",
        (plan_id, data.get('lap', 0), data.get('session_time_s', 0), now)
    )
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/pit_stop/exit', methods=['POST'])
def pit_stop_exit(plan_id):
    data  = request.get_json() or {}
    exit_t = float(data.get('session_time_s', 0))
    row = db_exec(
        "SELECT id, entry_time_s FROM pit_stops WHERE plan_id=%s AND exit_time_s IS NULL ORDER BY id DESC LIMIT 1",
        (plan_id,)
    ).fetchone()
    if row:
        duration = round(exit_t - row['entry_time_s'], 1)
        db_exec(
            "UPDATE pit_stops SET exit_time_s=%s, duration_s=%s WHERE id=%s",
            (exit_t, duration, row['id'])
        )
        db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/pit_stops', methods=['GET'])
def get_pit_stops(plan_id):
    rows = db_exec(
        "SELECT entry_lap, duration_s, logged_at FROM pit_stops WHERE plan_id=%s AND duration_s IS NOT NULL ORDER BY id DESC LIMIT 20",
        (plan_id,)
    ).fetchall()
    stops = [dict(r) for r in rows]
    avg = round(sum(s['duration_s'] for s in stops) / len(stops), 1) if stops else None
    best = round(min(s['duration_s'] for s in stops), 1) if stops else None
    return jsonify({'stops': stops, 'avg_s': avg, 'best_s': best, 'count': len(stops)})


# ---------------------------------------------------------------------------
# Routes — API: race plans
# ---------------------------------------------------------------------------

@app.route('/api/plans', methods=['GET'])
def list_plans():
    rows = db_exec(
        "SELECT id, name, created_at, updated_at, config FROM race_plans ORDER BY updated_at DESC"
    ).fetchall()
    plans = []
    for row in rows:
        p = dict(row)
        p['config'] = json.loads(p['config'])
        plans.append(p)
    return jsonify(plans)


@app.route('/api/plans', methods=['POST'])
def create_plan():
    data   = request.get_json()
    name   = data.get('name', 'Untitled Plan')
    config = data.get('config', {})
    now    = datetime.utcnow().isoformat()

    plan_id = db_exec(
        "INSERT INTO race_plans (name, created_at, updated_at, config) VALUES (%s, %s, %s, %s) RETURNING id",
        (name, now, now, json.dumps(config))
    ).fetchone()['id']
    db_commit()

    drivers_data = data.get('drivers', [])
    colors = ['#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ce93d8', '#80deea']
    for i, d in enumerate(drivers_data):
        color = d.get('color', colors[i % len(colors)])
        db_exec(
            "INSERT INTO drivers (plan_id, name, max_hours, min_hours, color, target_lap_s, target_fpl) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (plan_id, d['name'], d.get('max_hours', 2.0), d.get('min_hours', 0), color,
             d.get('target_lap_s'), d.get('target_fpl'))
        )
    db_commit()

    drivers = _get_drivers(plan_id)
    strategy = calculate_strategy(config, drivers)

    _save_stints(plan_id, strategy['stints'])
    db_commit()

    return jsonify({'id': plan_id, 'strategy': strategy}), 201


@app.route('/api/plans/<int:plan_id>', methods=['GET'])
def get_plan(plan_id):
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    plan                = dict(row)
    plan['config']      = json.loads(plan['config'])
    plan['drivers']     = _get_drivers(plan_id)
    plan['stints']      = _get_stints(plan_id)
    plan['events']      = _get_events(plan_id)
    plan['competitors'] = _get_competitors(plan_id)
    return jsonify(plan)


@app.route('/api/plans/<int:plan_id>', methods=['PUT'])
def update_plan(plan_id):
    data = request.get_json()
    now  = datetime.utcnow().isoformat()

    row = db_exec("SELECT id FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    if 'name' in data or 'config' in data:
        existing = dict(db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone())
        name   = data.get('name', existing['name'])
        config = data.get('config', json.loads(existing['config']))
        db_exec(
            "UPDATE race_plans SET name=%s, config=%s, updated_at=%s WHERE id=%s",
            (name, json.dumps(config), now, plan_id)
        )

    if 'drivers' in data:
        db_exec("DELETE FROM drivers WHERE plan_id=%s", (plan_id,))
        colors = ['#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ce93d8', '#80deea']
        for i, d in enumerate(data['drivers']):
            color = d.get('color', colors[i % len(colors)])
            db_exec(
                "INSERT INTO drivers (plan_id, name, max_hours, min_hours, color, target_lap_s, target_fpl) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (plan_id, d['name'], d.get('max_hours', 2.0), d.get('min_hours', 0), color,
                 d.get('target_lap_s'), d.get('target_fpl'))
            )

    db_commit()

    if 'config' in data or 'drivers' in data:
        cfg_row = db_exec("SELECT config FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
        config  = json.loads(cfg_row['config'])
        drivers = _get_drivers(plan_id)
        strategy = calculate_strategy(config, drivers)
        db_exec("DELETE FROM stints WHERE plan_id=%s", (plan_id,))
        _save_stints(plan_id, strategy['stints'])
        db_commit()

    plan                = dict(db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone())
    plan['config']      = json.loads(plan['config'])
    plan['drivers']     = _get_drivers(plan_id)
    plan['stints']      = _get_stints(plan_id)
    plan['events']      = _get_events(plan_id)
    plan['competitors'] = _get_competitors(plan_id)
    return jsonify(plan)


@app.route('/api/plans/<int:plan_id>', methods=['DELETE'])
def delete_plan(plan_id):
    db_exec("DELETE FROM race_plans WHERE id=%s", (plan_id,))
    db_commit()
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Routes — API: strategy recalc
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/recalculate', methods=['POST'])
def recalculate(plan_id):
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    config  = json.loads(row['config'])
    drivers = _get_drivers(plan_id)
    strategy = calculate_strategy(config, drivers)

    db_exec("DELETE FROM stints WHERE plan_id=%s", (plan_id,))
    _save_stints(plan_id, strategy['stints'])
    db_commit()

    strategy['stints'] = _get_stints(plan_id)
    return jsonify(strategy)


# ---------------------------------------------------------------------------
# Routes — API: optimizer
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/optimize', methods=['POST'])
def optimize_rotation(plan_id):
    """
    Try every permutation of driver order, return the rotation that either
    minimises pit stops ('minimize_pits') or most evenly distributes driving
    hours ('balance_hours').  Only the ordering changes — no DB write.
    """
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    config  = json.loads(row['config'])
    drivers = list(_get_drivers(plan_id))   # list of dicts
    data    = request.get_json() or {}
    mode    = data.get('mode', 'minimize_pits')

    if len(drivers) < 2:
        return jsonify({'error': 'Need at least 2 drivers to optimise'}), 400

    best_result  = None
    best_score   = float('inf')
    best_perm    = None

    for perm in permutations(range(len(drivers))):
        ordered = [drivers[i] for i in perm]
        result  = calculate_strategy(config, ordered)

        if mode == 'minimize_pits':
            score = result['pit_stops']
        else:  # balance_hours
            # Variance of hours driven per driver
            hours = {}
            for s in result['stints']:
                key = s['driver_name']
                lap_s = (drivers[perm[list(perm).index(
                    next((i for i, d in enumerate(drivers) if d['name'] == key), 0)
                )]].get('target_lap_s') or config.get('lap_time_s', 90))
                hours[key] = hours.get(key, 0) + s['laps_in_stint'] * lap_s / 3600
            vals  = list(hours.values())
            avg   = sum(vals) / len(vals) if vals else 0
            score = sum((v - avg) ** 2 for v in vals)

        if score < best_score:
            best_score  = score
            best_result = result
            best_perm   = list(perm)

    best_order = [drivers[i]['name'] for i in best_perm]
    return jsonify({
        'mode':        mode,
        'best_order':  best_order,
        'pit_stops':   best_result['pit_stops'],
        'total_stints': best_result['total_stints'],
        'stints':      best_result['stints'],
    })


# ---------------------------------------------------------------------------
# Routes — API: lap time bulk import
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/laps/import', methods=['POST'])
def import_laps(plan_id):
    """
    Bulk-insert lap times from a parsed array.
    Body: { "laps": [ {lap_num, time_s, driver_name?, note?}, ... ] }
    Returns count of rows inserted.
    """
    row = db_exec("SELECT id FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json() or {}
    laps = data.get('laps', [])
    if not laps:
        return jsonify({'error': 'No laps provided'}), 400

    now      = datetime.utcnow().isoformat()
    inserted = 0
    for lap in laps:
        lap_num = lap.get('lap_num')
        time_s  = lap.get('time_s')
        if not lap_num or not time_s or float(time_s) <= 0:
            continue

        driver_id = lap.get('driver_id')
        if not driver_id and lap.get('driver_name'):
            name    = lap['driver_name'].strip().lower()
            d_row   = db_exec(
                "SELECT id FROM drivers WHERE plan_id=%s AND LOWER(name)=%s",
                (plan_id, name)
            ).fetchone()
            if not d_row:
                d_row = db_exec(
                    "SELECT id FROM drivers WHERE plan_id=%s AND LOWER(name) LIKE %s",
                    (plan_id, f'%{name}%')
                ).fetchone()
            if d_row:
                driver_id = d_row['id']

        db_exec(
            """INSERT INTO lap_times (plan_id, lap_num, driver_id, time_s, note, logged_at)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (plan_id, int(lap_num), driver_id, float(time_s),
             lap.get('note', ''), now)
        )
        inserted += 1

    db_commit()
    return jsonify({'inserted': inserted}), 201


# ---------------------------------------------------------------------------
# Routes — API: telemetry bridge
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/telemetry', methods=['POST'])
def push_telemetry(plan_id):
    """
    Receive a live state snapshot from the local telemetry bridge.
    Body: { current_lap, fuel_level, last_lap_time_s?, session_time_s?,
            is_on_track?, session_info? }
    After saving, pushes a live_update event to all pit-wall clients
    watching this plan via SocketIO.
    """
    row = db_exec("SELECT id FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    data  = request.get_json() or {}
    new_lap   = data.get('current_lap') or 0
    new_fuel  = data.get('fuel_level')

    # Load previous telemetry for fuel delta computation
    prev_row = db_exec("SELECT telemetry_state FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    prev_state = {}
    if prev_row and prev_row['telemetry_state']:
        try:
            prev_state = json.loads(prev_row['telemetry_state'])
        except Exception:
            pass

    # Compute fuel-per-lap delta vs plan
    fuel_delta = prev_state.get('fuel_delta', {})
    prev_lap  = prev_state.get('current_lap') or 0
    prev_fuel = prev_state.get('fuel_level')
    if (new_fuel is not None and prev_fuel is not None
            and new_lap > prev_lap and new_lap - prev_lap == 1):
        actual_fpl = round(prev_fuel - new_fuel, 4)
        if 0.1 < actual_fpl < 5.0:   # sanity filter
            history = fuel_delta.get('history', [])
            history.append(actual_fpl)
            history = history[-10:]   # keep last 10 laps
            avg_actual = round(sum(history) / len(history), 4)
            fuel_delta = {
                'history':       history,
                'avg_actual_fpl': avg_actual,
                'last_actual_fpl': actual_fpl,
            }

    state = {
        'current_lap':      new_lap,
        'fuel_level':       new_fuel,
        'last_lap_time_s':  data.get('last_lap_time_s'),
        'session_time_s':   data.get('session_time_s'),
        'is_on_track':      data.get('is_on_track'),
        'session_info':     data.get('session_info'),
        'fuel_delta':       fuel_delta,
        'updated_at':       datetime.utcnow().isoformat(),
    }
    db_exec("UPDATE race_plans SET telemetry_state=%s WHERE id=%s",
            (json.dumps(state), plan_id))
    db_commit()

    # Push live status to all pit-wall clients watching this plan
    live = _calc_live_status(plan_id, data.get('current_lap'))
    if live:
        live['telemetry'] = {
            'fuel_level':      state['fuel_level'],
            'last_lap_time_s': state['last_lap_time_s'],
            'stale':           False,
        }
        socketio.emit('live_update', live, to=f'plan_{plan_id}')

    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/telemetry', methods=['GET'])
def get_telemetry(plan_id):
    row = db_exec("SELECT telemetry_state FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    state = json.loads(row['telemetry_state']) if row['telemetry_state'] else {}
    # Mark stale if updated more than 15 seconds ago
    if state.get('updated_at'):
        age_s = (datetime.utcnow() - datetime.fromisoformat(state['updated_at'])).total_seconds()
        state['stale'] = age_s > 15
    else:
        state['stale'] = True
    return jsonify(state)


# ---------------------------------------------------------------------------
# Routes — API: restrategize
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/restrategize', methods=['POST'])
def restrategize(plan_id):
    """
    Recalculate strategy using a new lap time (e.g. derived from actual pace).
    Body: { new_lap_time_s: float }
    Updates config.lap_time_s and rebuilds stints.
    """
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    data         = request.get_json() or {}
    new_lap_s    = float(data.get('new_lap_time_s', 0))
    if new_lap_s <= 0:
        return jsonify({'error': 'Invalid lap time'}), 400

    config               = json.loads(row['config'])
    config['lap_time_s'] = new_lap_s
    now                  = datetime.utcnow().isoformat()

    db_exec("UPDATE race_plans SET config=%s, updated_at=%s WHERE id=%s",
            (json.dumps(config), now, plan_id))
    db_commit()

    drivers  = _get_drivers(plan_id)
    strategy = calculate_strategy(config, drivers)
    db_exec("DELETE FROM stints WHERE plan_id=%s", (plan_id,))
    _save_stints(plan_id, strategy['stints'])
    db_commit()

    plan            = dict(db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone())
    plan['config']  = json.loads(plan['config'])
    plan['drivers'] = _get_drivers(plan_id)
    plan['stints']  = _get_stints(plan_id)
    plan['events']  = _get_events(plan_id)
    return jsonify(plan)


# ---------------------------------------------------------------------------
# Routes — API: competitors
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/competitors', methods=['GET'])
def list_competitors(plan_id):
    rows = db_exec(
        "SELECT * FROM competitors WHERE plan_id=%s ORDER BY id", (plan_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/plans/<int:plan_id>/competitors', methods=['POST'])
def add_competitor(plan_id):
    row = db_exec("SELECT id FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    data = request.get_json() or {}
    comp_id = db_exec(
        """INSERT INTO competitors (plan_id, car_num, name, laps_per_tank, current_lap, color)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (plan_id, data.get('car_num', '?'), data.get('name', ''),
         data.get('laps_per_tank', 25), data.get('current_lap', 0),
         data.get('color', '#ff8a65'))
    ).fetchone()['id']
    db_commit()
    return jsonify({'id': comp_id}), 201


@app.route('/api/plans/<int:plan_id>/competitors/<int:comp_id>', methods=['PATCH'])
def update_competitor(plan_id, comp_id):
    data    = request.get_json() or {}
    allowed = ('car_num', 'name', 'laps_per_tank', 'current_lap', 'color')
    fields, values = [], []
    for k in allowed:
        if k in data:
            fields.append(f"{k}=%s")
            values.append(data[k])
    if not fields:
        return jsonify({'ok': True})
    values.extend([comp_id, plan_id])
    db_exec(f"UPDATE competitors SET {', '.join(fields)} WHERE id=%s AND plan_id=%s",
            tuple(values))
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/competitors/<int:comp_id>', methods=['DELETE'])
def delete_competitor(plan_id, comp_id):
    db_exec("DELETE FROM competitors WHERE id=%s AND plan_id=%s", (comp_id, plan_id))
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/competitors/sync', methods=['POST'])
def sync_competitors(plan_id):
    """
    Bulk-update current_lap and on_pit_road for competitors the user has
    already added manually.  Called by the telemetry bridge every ~5 s.
    Does NOT auto-insert — the user controls which cars they track.
    Body: { competitors: [{car_num, current_lap, on_pit_road}, ...] }
    """
    row = db_exec("SELECT id FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json() or {}
    for c in data.get('competitors', []):
        car_num = str(c.get('car_num', '')).strip()
        if not car_num:
            continue
        existing = db_exec(
            "SELECT id FROM competitors WHERE plan_id=%s AND car_num=%s",
            (plan_id, car_num)
        ).fetchone()
        if existing:
            db_exec(
                "UPDATE competitors SET current_lap=%s, on_pit_road=%s WHERE id=%s",
                (int(c.get('current_lap', 0)),
                 1 if c.get('on_pit_road') else 0,
                 existing['id'])
            )
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/fuel_emergency', methods=['GET'])
def fuel_emergency(plan_id):
    """
    Given current lap + fuel level (from query params or stored telemetry),
    return whether each fuel mode can survive to the planned pit window and
    a plain-English recommendation.
    """
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    config       = json.loads(row['config'])
    current_lap  = request.args.get('current_lap', type=int)
    current_fuel = request.args.get('current_fuel', type=float)

    # Fall back to stored telemetry
    if current_lap is None or current_fuel is None:
        ts = json.loads(row['telemetry_state']) if row.get('telemetry_state') else {}
        if current_lap  is None: current_lap  = ts.get('current_lap') or 1
        if current_fuel is None: current_fuel = ts.get('fuel_level')

    if current_fuel is None:
        return jsonify({'error': 'No fuel level available — start telemetry bridge first'}), 400

    stints        = _get_stints(plan_id)
    current_stint = next((s for s in stints
                          if s['start_lap'] <= current_lap <= s['end_lap']), None)

    if not current_stint or not current_stint.get('pit_lap'):
        return jsonify({'status': 'ok', 'message': 'Final stint — no pit needed.'})

    planned_pit  = current_stint['pit_lap']
    laps_to_pit  = max(planned_pit - current_lap, 0)
    base_fpl     = config.get('fuel_per_lap_l', 0.92)

    scenarios = []
    for mode, mult in FUEL_MODE_MULTIPLIERS.items():
        eff_fpl     = base_fpl * mult
        fuel_needed = laps_to_pit * eff_fpl
        margin      = current_fuel - fuel_needed
        laps_left   = current_fuel / eff_fpl if eff_fpl > 0 else 0
        scenarios.append({
            'mode':          mode,
            'effective_fpl': round(eff_fpl, 3),
            'fuel_needed':   round(fuel_needed, 2),
            'fuel_margin':   round(margin, 2),
            'laps_of_fuel':  round(laps_left, 1),
            'can_make_it':   margin >= eff_fpl * 0.5,   # half-lap buffer
        })

    normal_s = next(s for s in scenarios if s['mode'] == 'normal')
    save_s   = next(s for s in scenarios if s['mode'] == 'save')

    if normal_s['can_make_it']:
        rec = {'level': 'ok',
               'message': 'Current fuel is sufficient on normal mode.'}
    elif save_s['can_make_it']:
        rec = {'level': 'warning',
               'message': f"Switch to SAVE mode now. "
                          f"Arrive with ~{save_s['fuel_margin']:.1f} gal margin."}
    else:
        earliest_pit = current_lap + max(int(save_s['laps_of_fuel']) - 1, 0)
        rec = {'level': 'critical',
               'message': f"Cannot reach lap {planned_pit} even on SAVE. "
                          f"Must pit by lap {earliest_pit}."}

    return jsonify({
        'current_lap':     current_lap,
        'current_fuel':    current_fuel,
        'planned_pit_lap': planned_pit,
        'laps_to_pit':     laps_to_pit,
        'scenarios':       scenarios,
        'recommendation':  rec,
    })


@app.route('/api/plans/<int:plan_id>/contingencies', methods=['GET'])
def contingencies(plan_id):
    """
    Return three pre-computed alternative strategies alongside the main plan:
      main      — current config as-is
      save_mode — run save fuel mode (may eliminate 1+ stops)
      short_fill — fill only 80% of tank each stop (+1 or more stops)
    No DB writes — all computed on the fly.
    """
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    config  = json.loads(row['config'])
    drivers = list(_get_drivers(plan_id))

    main_result = calculate_strategy(config, drivers)

    save_config  = {**config, 'fuel_mode': 'save'}
    save_result  = calculate_strategy(save_config, drivers)

    short_cap    = round(config['fuel_capacity_l'] * 0.80, 1)
    short_config = {**config, 'fuel_capacity_l': short_cap}
    short_result = calculate_strategy(short_config, drivers)

    def summarise(result, label, note):
        return {
            'label':        label,
            'note':         note,
            'pit_stops':    result['pit_stops'],
            'total_stints': result['total_stints'],
            'laps_per_tank': result['laps_per_tank'],
            'stints':       result['stints'],
        }

    return jsonify({
        'main':       summarise(main_result,  'Main plan',
                                f"Normal mode — {config['fuel_capacity_l']} gal fills"),
        'save_mode':  summarise(save_result,  'Save-mode strategy',
                                '8% fuel saving per lap — may reduce pit count'),
        'short_fill': summarise(short_result, 'Short-fill strategy',
                                f'{short_cap} gal fills ({int(80)}% tank) — faster stops, +stops'),
    })


# ---------------------------------------------------------------------------
# Routes — API: debrief
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/debrief', methods=['GET'])
def get_debrief(plan_id):
    """
    Return planned vs actual analysis per stint and per driver.
    """
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    config  = json.loads(row['config'])
    stints  = _get_stints(plan_id)
    drivers = _get_drivers(plan_id)
    laps_raw = db_exec(
        """SELECT lt.lap_num, lt.time_s, lt.driver_id, d.name AS driver_name, d.color AS driver_color
           FROM lap_times lt LEFT JOIN drivers d ON lt.driver_id=d.id
           WHERE lt.plan_id=%s ORDER BY lt.lap_num""",
        (plan_id,)
    ).fetchall()

    lap_time_s = config.get('lap_time_s', 90)
    mode_mult  = FUEL_MODE_MULTIPLIERS.get(config.get('fuel_mode', 'normal'), 1.0)
    fpl        = config.get('fuel_per_lap_l', 0.92) * mode_mult

    stint_analysis = []
    for s in stints:
        planned_laps  = s['end_lap'] - s['start_lap'] + 1
        actual_end    = s['actual_end_lap'] or s['end_lap']
        actual_laps   = actual_end - s['start_lap'] + 1
        lap_delta     = actual_laps - planned_laps

        # Lap times in this stint's range
        stint_laps_data = [l for l in laps_raw
                           if s['start_lap'] <= l['lap_num'] <= actual_end]
        times     = [l['time_s'] for l in stint_laps_data]
        avg_time  = sum(times) / len(times) if times else None
        pace_delta = (avg_time - lap_time_s) if avg_time else None

        stint_analysis.append({
            'stint_num':         s['stint_num'],
            'driver_name':       s['driver_name'],
            'driver_color':      s['driver_color'],
            'planned_laps':      planned_laps,
            'actual_laps':       actual_laps,
            'lap_delta':         lap_delta,
            'planned_fuel':      s['fuel_load'],
            'actual_fuel':       s['actual_fuel_added'],
            'fuel_delta':        round(s['actual_fuel_added'] - s['fuel_load'], 2)
                                 if s['actual_fuel_added'] is not None else None,
            'avg_lap_time_s':    round(avg_time, 3) if avg_time else None,
            'pace_delta_s':      round(pace_delta, 3) if pace_delta is not None else None,
            'laps_logged':       len(times),
        })

    # Per-driver summary
    driver_stats = {}
    for d in drivers:
        dtimes = [l['time_s'] for l in laps_raw if l['driver_id'] == d['id']]
        if not dtimes:
            continue
        driver_stats[d['name']] = {
            'name':    d['name'],
            'color':   d['color'],
            'laps':    len(dtimes),
            'best':    min(dtimes),
            'avg':     sum(dtimes) / len(dtimes),
            'worst':   max(dtimes),
            'std_dev': (sum((t - sum(dtimes)/len(dtimes))**2 for t in dtimes) / len(dtimes)) ** 0.5,
        }

    return jsonify({
        'stints':       stint_analysis,
        'driver_stats': list(driver_stats.values()),
        'planned_lap_s': lap_time_s,
        'planned_fpl':   fpl,
    })


# ---------------------------------------------------------------------------
# Routes — API: undercut / overcut calculator
# ---------------------------------------------------------------------------

@app.route('/api/undercut', methods=['POST'])
def undercut_calc():
    """
    Stateless calculator — no DB required.
    Body:
      our_gap_s        : float  — gap to competitor in seconds (positive = we're behind)
      pit_loss_s       : float  — our total pit stop loss time
      our_laps_to_pit  : int    — laps until our planned pit
      comp_laps_to_pit : int    — laps until competitor's estimated pit
      lap_time_s       : float  — our lap time in seconds
      comp_lap_time_s  : float  — competitor lap time (0 = same as ours)

    Returns: analysis for pit-now (undercut), pit-at-plan, and pit-late (overcut).
    """
    data = request.get_json() or {}
    our_gap       = float(data.get('our_gap_s', 0))          # positive = behind
    pit_loss      = float(data.get('pit_loss_s', 35))
    our_laps      = int(data.get('our_laps_to_pit', 0))
    comp_laps     = int(data.get('comp_laps_to_pit', 0))
    lap_s         = float(data.get('lap_time_s', 90))
    comp_lap_s    = float(data.get('comp_lap_time_s', 0)) or lap_s

    def calc_exit_gap(our_extra_laps):
        """
        our_extra_laps: how many more laps we do compared to the undercut scenario (0 = pit now).
        Returns gap to competitor on exit (negative = we exit ahead).
        """
        # We pit after our_extra_laps more laps; competitor pits at comp_laps
        our_pit_in   = our_extra_laps          # laps until we pit from now
        comp_pit_in  = comp_laps               # laps until comp pits

        # Time on track from now until we exit pits
        time_until_we_exit  = our_pit_in * lap_s + pit_loss
        # Time until competitor exits pits (if they pit at comp_pit_in)
        time_until_comp_exit = comp_pit_in * comp_lap_s + pit_loss

        # During the time we're in our stop, competitor is still on track
        # Gap adjustment: if we pit first, competitor gains track time on us
        gap_at_our_exit = (our_gap                                # starting gap
                           + comp_lap_s * our_pit_in              # comp covers laps while we run
                           + pit_loss                             # comp gains our stop time
                           - lap_s * our_pit_in)                  # we ran these laps too

        # Simplified: after all stops are done, net gap change
        # We're ahead if gap_at_our_exit < 0 (we exited in front)
        return round(gap_at_our_exit, 1)

    undercut_gap    = calc_exit_gap(0)               # pit this lap
    planned_gap     = calc_exit_gap(our_laps)         # pit at plan
    overcut_gap     = calc_exit_gap(our_laps + 3)     # pit 3 laps late

    def label(gap):
        if gap < -2:   return 'ahead'
        if gap < 2:    return 'side-by-side'
        return 'behind'

    return jsonify({
        'undercut': {'exit_gap_s': undercut_gap,  'position': label(undercut_gap),
                     'description': 'Pit this lap (undercut)'},
        'planned':  {'exit_gap_s': planned_gap,   'position': label(planned_gap),
                     'description': f'Pit at planned lap (in {our_laps} laps)'},
        'overcut':  {'exit_gap_s': overcut_gap,   'position': label(overcut_gap),
                     'description': f'Pit 3 laps late (overcut)'},
    })


# ---------------------------------------------------------------------------
# Routes — Mobile Pit Wall
# ---------------------------------------------------------------------------

@app.route('/pitwall')
@app.route('/pitwall/<int:plan_id>')
def pitwall(plan_id=None):
    return render_template('pitwall.html', plan_id=plan_id or '')


# ---------------------------------------------------------------------------
# Routes — API: live mode
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/stints/<int:stint_id>', methods=['PATCH'])
def patch_stint(plan_id, stint_id):
    """Update tire data (and optionally completion state) for a single stint."""
    data    = request.get_json() or {}
    allowed = ('driver_id', 'tire_compound', 'tire_set', 'tire_age_laps', 'tire_wear_pct',
               'is_complete', 'actual_end_lap', 'actual_fuel_added')
    fields  = []
    values  = []
    for key in allowed:
        if key in data:
            fields.append(f"{key}=%s")
            val = data[key]
            # treat empty string as NULL
            values.append(None if val == '' else val)
    if not fields:
        return jsonify({'ok': True})
    values.extend([stint_id, plan_id])
    db_exec(
        f"UPDATE stints SET {', '.join(fields)} WHERE id=%s AND plan_id=%s",
        tuple(values)
    )
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/stints/<int:stint_id>/complete', methods=['POST'])
def complete_stint(plan_id, stint_id):
    data       = request.get_json() or {}
    actual_end = data.get('actual_end_lap')
    db_exec(
        "UPDATE stints SET is_complete=1, actual_end_lap=%s WHERE id=%s AND plan_id=%s",
        (actual_end, stint_id, plan_id)
    )
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/laps', methods=['GET'])
def get_lap_times(plan_id):
    rows = db_exec(
        """SELECT lt.id, lt.lap_num, lt.time_s, lt.note, lt.logged_at,
                  lt.driver_id,
                  d.name AS driver_name, d.color AS driver_color
           FROM lap_times lt
           LEFT JOIN drivers d ON lt.driver_id = d.id
           WHERE lt.plan_id=%s
           ORDER BY lt.lap_num ASC, lt.logged_at ASC""",
        (plan_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/plans/<int:plan_id>/laps', methods=['POST'])
def add_lap_time(plan_id):
    data = request.get_json()
    if 'lap_num' not in data or 'time_s' not in data:
        return jsonify({'error': 'lap_num and time_s required'}), 400

    # Resolve driver_id from name if not supplied directly
    driver_id = data.get('driver_id')
    if not driver_id and data.get('driver_name'):
        name = data['driver_name'].strip().lower()
        row = db_exec(
            "SELECT id FROM drivers WHERE plan_id=%s AND LOWER(name)=%s",
            (plan_id, name)
        ).fetchone()
        if not row:
            # Fuzzy: partial match
            row = db_exec(
                "SELECT id FROM drivers WHERE plan_id=%s AND LOWER(name) LIKE %s",
                (plan_id, f'%{name}%')
            ).fetchone()
        if row:
            driver_id = row['id']

    now    = datetime.utcnow().isoformat()
    lap_id = db_exec(
        """INSERT INTO lap_times (plan_id, lap_num, driver_id, time_s, note, logged_at)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (plan_id, data['lap_num'], driver_id,
         data['time_s'], data.get('note', ''), now)
    ).fetchone()['id']
    db_commit()
    return jsonify({'id': lap_id, 'driver_id': driver_id}), 201


@app.route('/api/plans/<int:plan_id>/laps/<int:lap_id>', methods=['DELETE'])
def delete_lap_time(plan_id, lap_id):
    db_exec("DELETE FROM lap_times WHERE id=%s AND plan_id=%s", (lap_id, plan_id))
    db_commit()
    return jsonify({'ok': True})


@app.route('/api/plans/<int:plan_id>/events', methods=['POST'])
def add_event(plan_id):
    data = request.get_json()
    now  = datetime.utcnow().isoformat()
    event_id = db_exec(
        "INSERT INTO live_events (plan_id, lap, event_type, note, created_at) VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (plan_id, data['lap'], data.get('event_type', 'note'), data.get('note', ''), now)
    ).fetchone()['id']
    db_commit()
    return jsonify({'id': event_id}), 201


def _calc_live_status(plan_id, current_lap=None):
    """
    Core live-status calculation, usable by both the HTTP route and the
    SocketIO telemetry push.  Returns a plain dict (not a Response).
    """
    if current_lap is None:
        plan_row_t = db_exec("SELECT telemetry_state FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
        if plan_row_t and plan_row_t['telemetry_state']:
            ts = json.loads(plan_row_t['telemetry_state'])
            current_lap = ts.get('current_lap') or 1
        else:
            current_lap = 1

    stints = _get_stints(plan_id)
    if not stints:
        return None

    current_stint = None
    next_stint    = None
    for i, s in enumerate(stints):
        if s['start_lap'] <= current_lap <= s['end_lap']:
            current_stint = s
            if i + 1 < len(stints):
                next_stint = stints[i + 1]
            break

    if not current_stint:
        return {'status': 'finished', 'current_lap': current_lap}

    laps_until_pit = (current_stint['pit_lap'] or current_stint['end_lap']) - current_lap

    plan_row      = db_exec("SELECT config FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    config        = json.loads(plan_row['config'])
    lap_time_s    = config.get('lap_time_s', 90)
    fuel_per_lap  = config.get('fuel_per_lap_l', 0.92)
    fuel_mode     = config.get('fuel_mode', 'normal')
    fuel_capacity = config.get('fuel_capacity_l', 18)
    effective_fpl = fuel_per_lap * FUEL_MODE_MULTIPLIERS.get(fuel_mode, 1.0)

    mins_until_pit  = round(laps_until_pit * lap_time_s / 60, 1)
    laps_into_stint = max(current_lap - current_stint['start_lap'], 0)
    fuel_remaining  = max((current_stint['fuel_load'] or 0) - laps_into_stint * effective_fpl, 0)
    laps_of_fuel    = (fuel_remaining / effective_fpl) if effective_fpl > 0 else 0
    fuel_pct        = round((fuel_remaining / fuel_capacity) * 100) if fuel_capacity > 0 else 0

    planned_pit       = current_stint.get('pit_lap')
    last_safe_lap     = current_lap + max(int(math.floor(laps_of_fuel)) - 1, 0)
    pit_window_status = 'green'
    if planned_pit:
        if current_lap > planned_pit:
            pit_window_status = 'red'
        elif laps_until_pit <= 2:
            pit_window_status = 'yellow'

    return {
        'status':             'racing',
        'current_lap':        current_lap,
        'current_stint':      dict(current_stint),
        'next_stint':         dict(next_stint) if next_stint else None,
        'laps_until_pit':     laps_until_pit,
        'mins_until_pit':     mins_until_pit,
        'alert':              laps_until_pit <= 3 and laps_until_pit > 0,
        'fuel_remaining_l':   round(fuel_remaining, 1),
        'laps_of_fuel':       round(laps_of_fuel, 1),
        'fuel_pct':           fuel_pct,
        'pit_window_optimal': planned_pit,
        'pit_window_last':    last_safe_lap,
        'pit_window_status':  pit_window_status,
    }


@app.route('/api/plans/<int:plan_id>/live_status', methods=['GET'])
def live_status(plan_id):
    """Return current stint, next pit window, and laps until pit."""
    current_lap = request.args.get('lap', type=int, default=None)
    result = _calc_live_status(plan_id, current_lap)
    if result is None:
        return jsonify({'error': 'No stints found'}), 404
    return jsonify(result)


# ---------------------------------------------------------------------------
# Routes — API: AI engineer context
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/engineer-context', methods=['GET'])
def engineer_context(plan_id):
    """
    Returns a single rich JSON snapshot for the AI Race Engineer.
    Combines plan config, live status, telemetry, competitors, and pit history.
    """
    # Fetch the plan row
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    config  = json.loads(row['config'])
    drivers = _get_drivers(plan_id)

    # Strategy summary for total_stints / pit_stops counts
    strategy_meta = calculate_strategy(config, list(drivers))

    # Build plan block
    plan_block = {
        'id':              plan_id,
        'name':            row['name'],
        'config':          config,
        'drivers':         [dict(d) for d in drivers],
        'total_stints':    strategy_meta['total_stints'],
        'pit_stops_planned': strategy_meta['pit_stops'],
    }

    # Live status
    live_block = _calc_live_status(plan_id, current_lap=None)

    # Telemetry
    telem_row   = db_exec("SELECT telemetry_state FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    telem_state = json.loads(telem_row['telemetry_state']) if (telem_row and telem_row['telemetry_state']) else {}
    if telem_state.get('updated_at'):
        age_s = (datetime.utcnow() - datetime.fromisoformat(telem_state['updated_at'])).total_seconds()
        telem_stale = age_s > 15
    else:
        telem_stale = True

    telemetry_block = {
        'current_lap':       telem_state.get('current_lap'),
        'fuel_level':        telem_state.get('fuel_level'),
        'last_lap_time_s':   telem_state.get('last_lap_time_s'),
        'session_time_s':    telem_state.get('session_time_s'),
        'fuel_delta':        telem_state.get('fuel_delta'),
        'stale':             telem_stale,
    }

    # Competitors
    competitors_rows = _get_competitors(plan_id)
    competitors_block = [
        {
            'car_num':      c.get('car_num'),
            'name':         c.get('name'),
            'current_lap':  c.get('current_lap'),
            'on_pit_road':  c.get('on_pit_road'),
        }
        for c in (dict(r) for r in competitors_rows)
    ]

    # Recent pit stops (last 5 completed)
    pit_rows = db_exec(
        "SELECT entry_lap, duration_s FROM pit_stops WHERE plan_id=%s AND duration_s IS NOT NULL ORDER BY id DESC LIMIT 5",
        (plan_id,)
    ).fetchall()
    recent_pit_stops = [dict(r) for r in pit_rows]

    return jsonify({
        'plan':             plan_block,
        'live':             live_block,
        'telemetry':        telemetry_block,
        'competitors':      competitors_block,
        'recent_pit_stops': recent_pit_stops,
    })


# ---------------------------------------------------------------------------
# Routes — API: export
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/export', methods=['GET'])
def export_plan(plan_id):
    row = db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    plan            = dict(row)
    plan['config']  = json.loads(plan['config'])
    plan['drivers'] = _get_drivers(plan_id)
    plan['stints']  = _get_stints(plan_id)
    plan['events']  = _get_events(plan_id)

    config = plan['config']
    strategy_meta = calculate_strategy(config, plan['drivers'])
    plan['meta'] = {
        'total_laps':     strategy_meta['total_laps'],
        'laps_per_tank':  strategy_meta['laps_per_tank'],
        'laps_per_stint': strategy_meta['laps_per_stint'],
        'fuel_per_lap':   strategy_meta['fuel_per_lap'],
        'total_stints':   strategy_meta['total_stints'],
        'pit_stops':      strategy_meta['pit_stops'],
    }
    return jsonify(plan)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _get_drivers(plan_id):
    return db_exec(
        "SELECT id, name, max_hours, min_hours, color, target_lap_s, target_fpl FROM drivers WHERE plan_id=%s ORDER BY id",
        (plan_id,)
    ).fetchall()


def _get_stints(plan_id):
    return db_exec(
        """SELECT s.id, s.stint_num, s.start_lap, s.end_lap, s.pit_lap,
                  s.fuel_load, s.fuel_mode, s.is_complete, s.actual_end_lap,
                  s.tire_compound, s.tire_set, s.tire_age_laps, s.tire_wear_pct,
                  s.actual_fuel_added,
                  s.driver_id,
                  d.name AS driver_name, d.color AS driver_color
           FROM stints s
           LEFT JOIN drivers d ON s.driver_id = d.id
           WHERE s.plan_id=%s
           ORDER BY s.stint_num""",
        (plan_id,)
    ).fetchall()


def _get_competitors(plan_id):
    return db_exec(
        "SELECT * FROM competitors WHERE plan_id=%s ORDER BY id", (plan_id,)
    ).fetchall()


def _get_events(plan_id):
    return db_exec(
        "SELECT * FROM live_events WHERE plan_id=%s ORDER BY lap, created_at",
        (plan_id,)
    ).fetchall()


def _save_stints(plan_id, stints):
    for s in stints:
        db_exec(
            """INSERT INTO stints
               (plan_id, stint_num, driver_id, start_lap, end_lap, pit_lap, fuel_load, fuel_mode)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (plan_id, s['stint_num'], s.get('driver_id'), s['start_lap'],
             s['end_lap'], s.get('pit_lap'), s['fuel_load'], s['fuel_mode'])
        )


# ---------------------------------------------------------------------------
# SocketIO events
# ---------------------------------------------------------------------------

@socketio.on('join_plan')
def on_join_plan(data):
    plan_id = data.get('plan_id')
    if plan_id:
        join_room(f'plan_{plan_id}')


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5002))
    socketio.run(app, debug=False, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
