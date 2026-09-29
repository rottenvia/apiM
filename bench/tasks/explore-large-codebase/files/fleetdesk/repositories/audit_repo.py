from __future__ import annotations

AUDIT_TABLE = "audit_events"


class AuditRepository:
    """Append-only audit trail.

    Writes go through the shared JournalWriter, which batches rows; reads hit
    the table directly (call JournalWriter.flush() first if you need to see
    records from the current request).
    """

    def __init__(self, db, journal):
        self._db = db
        self._journal = journal

    def append(self, event) -> None:
        self._journal.enqueue(AUDIT_TABLE, {
            "id": event.id,
            "at": event.at,
            "actor": event.actor,
            "action": event.action,
            "target": event.target,
            "details": event.details_json(),
        })

    def list_recent(self, limit=200):
        return self._db.query(f"SELECT * FROM {AUDIT_TABLE} ORDER BY at DESC LIMIT ?", (limit,))

    def for_target(self, target):
        return self._db.query(f"SELECT * FROM {AUDIT_TABLE} WHERE target = ? ORDER BY at", (target,))

    def write_legacy(self, actor, action, target):
        """Synchronous write to the pre-2024 audit table.

        Only used by scripts/migrate_audit_v1.py (not part of the service)."""
        self._db.execute("INSERT INTO audit_log_v1 (actor, action, target) VALUES (?, ?, ?)", (actor, action, target))
