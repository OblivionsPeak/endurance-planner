import os
import json
import math
import psycopg2
import psycopg2.extras
from datetime import datetime
from flask import Flask, render_template, request, jsonify, g
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
DATABASE_URL = os.environ.get('DATABASE_URL')

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
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_compound TEXT")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_set TEXT")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_age_laps INTEGER")
    cur.execute("ALTER TABLE stints ADD COLUMN IF NOT EXISTS tire_wear_pct FLOAT")
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

    config keys:
      race_duration_hrs, fuel_capacity_l, fuel_per_lap_l, lap_time_s,
      num_drivers, pit_loss_s, fuel_mode

    Returns list of:
      { stint_num, driver_name, driver_id, start_lap, end_lap, pit_lap,
        fuel_load, fuel_mode, laps_in_stint }
    """
    race_dur_s    = config['race_duration_hrs'] * 3600
    lap_time_s    = config['lap_time_s']
    fuel_capacity = config['fuel_capacity_l']
    base_fpl      = config['fuel_per_lap_l']
    pit_loss_s    = config.get('pit_loss_s', 30)
    fuel_mode     = config.get('fuel_mode', 'normal')
    max_continuous_hrs = config.get('max_continuous_hrs', 2.5)

    multiplier    = FUEL_MODE_MULTIPLIERS.get(fuel_mode, 1.0)
    fuel_per_lap  = base_fpl * multiplier

    # usable laps per full tank (with safety buffer)
    usable_fuel   = fuel_capacity - (fuel_per_lap * SAFETY_BUFFER_LAPS)
    laps_per_tank = int(math.floor(usable_fuel / fuel_per_lap))

    # max laps per driver based on fatigue limit
    max_stint_laps_fatigue = int(math.floor(max_continuous_hrs * 3600 / lap_time_s))

    # actual laps per stint = min of tank range and fatigue limit
    laps_per_stint = min(laps_per_tank, max_stint_laps_fatigue)

    # total laps in race (approximate — race ends at time, not lap)
    total_laps = int(math.floor(race_dur_s / lap_time_s))

    stints = []
    current_lap  = 1
    stint_num    = 1
    driver_index = 0
    n_drivers    = max(len(drivers), 1)

    while current_lap <= total_laps:
        remaining_laps = total_laps - current_lap + 1
        stint_laps = min(laps_per_stint, remaining_laps)
        end_lap    = current_lap + stint_laps - 1

        # pit on last lap of stint (unless this is the final stint)
        is_last = (end_lap >= total_laps)
        pit_lap  = end_lap if not is_last else None

        fuel_load = round(stint_laps * fuel_per_lap + fuel_per_lap * SAFETY_BUFFER_LAPS, 2)
        fuel_load = min(fuel_load, fuel_capacity)   # cap at tank size

        driver = drivers[driver_index % n_drivers] if drivers else {'name': f'Driver {(driver_index % n_drivers) + 1}', 'id': None, 'color': '#4fc3f7'}

        stints.append({
            'stint_num':       stint_num,
            'driver_name':     driver.get('name', ''),
            'driver_id':       driver.get('id'),
            'driver_color':    driver.get('color', '#4fc3f7'),
            'start_lap':       current_lap,
            'end_lap':         end_lap,
            'pit_lap':         pit_lap,
            'fuel_load':       fuel_load,
            'fuel_mode':       fuel_mode,
            'laps_in_stint':   stint_laps,
            'is_last':         is_last,
        })

        current_lap   = end_lap + 1
        stint_num    += 1
        driver_index += 1

    return {
        'stints':          stints,
        'total_laps':      total_laps,
        'laps_per_tank':   laps_per_tank,
        'laps_per_stint':  laps_per_stint,
        'fuel_per_lap':    round(fuel_per_lap, 3),
        'total_stints':    len(stints),
        'pit_stops':       max(len(stints) - 1, 0),
    }


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html')


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
            "INSERT INTO drivers (plan_id, name, max_hours, min_hours, color) VALUES (%s, %s, %s, %s, %s)",
            (plan_id, d['name'], d.get('max_hours', 2.0), d.get('min_hours', 0), color)
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

    plan            = dict(row)
    plan['config']  = json.loads(plan['config'])
    plan['drivers'] = _get_drivers(plan_id)
    plan['stints']  = _get_stints(plan_id)
    plan['events']  = _get_events(plan_id)
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
                "INSERT INTO drivers (plan_id, name, max_hours, min_hours, color) VALUES (%s, %s, %s, %s, %s)",
                (plan_id, d['name'], d.get('max_hours', 2.0), d.get('min_hours', 0), color)
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

    plan            = dict(db_exec("SELECT * FROM race_plans WHERE id=%s", (plan_id,)).fetchone())
    plan['config']  = json.loads(plan['config'])
    plan['drivers'] = _get_drivers(plan_id)
    plan['stints']  = _get_stints(plan_id)
    plan['events']  = _get_events(plan_id)
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
# Routes — API: live mode
# ---------------------------------------------------------------------------

@app.route('/api/plans/<int:plan_id>/stints/<int:stint_id>', methods=['PATCH'])
def patch_stint(plan_id, stint_id):
    """Update tire data (and optionally completion state) for a single stint."""
    data    = request.get_json() or {}
    allowed = ('driver_id', 'tire_compound', 'tire_set', 'tire_age_laps', 'tire_wear_pct', 'is_complete', 'actual_end_lap')
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


@app.route('/api/plans/<int:plan_id>/live_status', methods=['GET'])
def live_status(plan_id):
    """Return current stint, next pit window, and laps until pit."""
    current_lap = request.args.get('lap', type=int, default=1)
    stints = _get_stints(plan_id)
    if not stints:
        return jsonify({'error': 'No stints found'}), 404

    current_stint = None
    next_stint    = None
    for i, s in enumerate(stints):
        if s['start_lap'] <= current_lap <= s['end_lap']:
            current_stint = s
            if i + 1 < len(stints):
                next_stint = stints[i + 1]
            break

    if not current_stint:
        return jsonify({'status': 'finished', 'current_lap': current_lap})

    laps_until_pit = (current_stint['pit_lap'] or current_stint['end_lap']) - current_lap

    plan_row   = db_exec("SELECT config FROM race_plans WHERE id=%s", (plan_id,)).fetchone()
    config     = json.loads(plan_row['config'])
    lap_time_s    = config.get('lap_time_s', 90)
    fuel_per_lap  = config.get('fuel_per_lap_l', 0.92)
    fuel_mode     = config.get('fuel_mode', 'normal')
    fuel_capacity = config.get('fuel_capacity_l', 18)
    effective_fpl = fuel_per_lap * FUEL_MODE_MULTIPLIERS.get(fuel_mode, 1.0)

    mins_until_pit = round(laps_until_pit * lap_time_s / 60, 1)

    # Fuel estimate: planned load minus what's been burned this stint
    laps_into_stint    = max(current_lap - current_stint['start_lap'], 0)
    fuel_used_stint    = laps_into_stint * effective_fpl
    fuel_remaining     = max((current_stint['fuel_load'] or 0) - fuel_used_stint, 0)
    laps_of_fuel       = (fuel_remaining / effective_fpl) if effective_fpl > 0 else 0
    fuel_pct           = round((fuel_remaining / fuel_capacity) * 100) if fuel_capacity > 0 else 0

    return jsonify({
        'status':           'racing',
        'current_lap':      current_lap,
        'current_stint':    dict(current_stint),
        'next_stint':       dict(next_stint) if next_stint else None,
        'laps_until_pit':   laps_until_pit,
        'mins_until_pit':   mins_until_pit,
        'alert':            laps_until_pit <= 3 and laps_until_pit > 0,
        'fuel_remaining_l': round(fuel_remaining, 1),
        'laps_of_fuel':     round(laps_of_fuel, 1),
        'fuel_pct':         fuel_pct,
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
        "SELECT id, name, max_hours, min_hours, color FROM drivers WHERE plan_id=%s ORDER BY id",
        (plan_id,)
    ).fetchall()


def _get_stints(plan_id):
    return db_exec(
        """SELECT s.id, s.stint_num, s.start_lap, s.end_lap, s.pit_lap,
                  s.fuel_load, s.fuel_mode, s.is_complete, s.actual_end_lap,
                  s.tire_compound, s.tire_set, s.tire_age_laps, s.tire_wear_pct,
                  s.driver_id,
                  d.name AS driver_name, d.color AS driver_color
           FROM stints s
           LEFT JOIN drivers d ON s.driver_id = d.id
           WHERE s.plan_id=%s
           ORDER BY s.stint_num""",
        (plan_id,)
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
# Bootstrap
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5002))
    app.run(debug=False, host='0.0.0.0', port=port)
