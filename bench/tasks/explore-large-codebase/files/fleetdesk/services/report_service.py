from __future__ import annotations

from ..utils.ids import new_id


class ReportService:
    def __init__(self, repos, config):
        self._repos = repos
        self._max_rows = config.get("reports.max_rows")
        self._jobs = {}

    def utilisation(self, start, end):
        rows = self._repos.trips.utilisation(start, end)
        return rows[: self._max_rows]

    def maintenance_costs(self, year):
        return self._repos.tickets.costs_by_vehicle(int(year) if year else None)

    def request_export(self, report, requested_by):
        job_id = new_id("exp")
        self._jobs[job_id] = {"report": report, "by": requested_by, "status": "queued"}
        return job_id
