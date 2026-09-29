"""Schema, applied in order. Each entry runs once; the version is kept in schema_version."""

MIGRATIONS = [
    """CREATE TABLE vehicles (id TEXT PRIMARY KEY, vin TEXT UNIQUE NOT NULL, plate TEXT NOT NULL,
        model TEXT, depot TEXT, status TEXT NOT NULL, registered_at TIMESTAMP)""",
    """CREATE TABLE drivers (id TEXT PRIMARY KEY, name TEXT, license_number TEXT, license_expires DATE,
        active INTEGER)""",
    """CREATE TABLE trips (id TEXT PRIMARY KEY, vehicle_id TEXT, driver_id TEXT, purpose TEXT,
        started_at TIMESTAMP, finished_at TIMESTAMP, distance_km REAL)""",
    "CREATE TABLE trips_archive AS SELECT * FROM trips WHERE 0",
    "CREATE TABLE trip_notes (trip_id TEXT, text TEXT, author TEXT, at TIMESTAMP)",
    "CREATE TABLE telematics_positions (vehicle_id TEXT, lat REAL, lon REAL, ts TIMESTAMP)",
    """CREATE TABLE maintenance_tickets (id TEXT PRIMARY KEY, vehicle_id TEXT, summary TEXT, severity TEXT,
        status TEXT, opened_at TIMESTAMP, assignee TEXT, resolution TEXT, cost_cents INTEGER, closed_at TIMESTAMP)""",
    """CREATE TABLE invoices (id TEXT PRIMARY KEY, customer_id TEXT, period_start DATE, period_end DATE,
        net_cents INTEGER, vat_cents INTEGER, currency TEXT, status TEXT, paid_cents INTEGER, finalized_at TIMESTAMP)""",
    "CREATE TABLE customer_depots (customer_id TEXT, depot TEXT)",
    "CREATE TABLE audit_log_v1 (actor TEXT, action TEXT, target TEXT, at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    """CREATE TABLE audit_events (id TEXT PRIMARY KEY, at TIMESTAMP, actor TEXT, action TEXT, target TEXT,
        details TEXT)""",
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, roles TEXT, password_hash TEXT)",
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TIMESTAMP)",
    "CREATE TABLE auth_tokens (token TEXT PRIMARY KEY, user_id TEXT, kind TEXT, expires_at TIMESTAMP)",
    "CREATE TABLE webhook_subscriptions (id TEXT PRIMARY KEY, event_type TEXT, url TEXT, active INTEGER)",
    "CREATE TABLE webhook_deliveries (subscription_id TEXT, event_type TEXT, ok INTEGER, at TIMESTAMP)",
]


def migrate(db) -> int:
    db.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)")
    row = db.query_one("SELECT MAX(version) AS v FROM schema_version", ())
    current = (row or {}).get("v") or 0
    for version, sql in enumerate(MIGRATIONS[current:], start=current + 1):
        db.execute(sql)
        db.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
    return len(MIGRATIONS) - current
