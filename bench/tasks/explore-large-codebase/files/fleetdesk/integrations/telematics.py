"""Client for the telematics provider's REST API."""
from __future__ import annotations

from urllib.parse import urlencode

from ..utils.retry import RetryPolicy, retry_call


class TelematicsClient:
    CONFIG_PREFIX = "integrations.telematics"

    def __init__(self, http, config):
        self._http = http
        self._base = config.get(f"{self.CONFIG_PREFIX}.base_url")
        self._policy = RetryPolicy.from_config(config, self.CONFIG_PREFIX)

    def fetch_events(self, start, end, vehicle_id=None):
        query = {"from": start.isoformat(), "to": end.isoformat()}
        if vehicle_id:
            query["vehicle"] = vehicle_id
        url = f"{self._base}/events?{urlencode(query)}"
        return retry_call(lambda: self._http.get_json(url), self._policy, retry_on=(TimeoutError, OSError))["events"]

    def distance_km(self, vehicle_id, start, end) -> float:
        url = f"{self._base}/vehicles/{vehicle_id}/distance?{urlencode({'from': start.isoformat(), 'to': end.isoformat()})}"
        data = retry_call(lambda: self._http.get_json(url), self._policy, retry_on=(TimeoutError, OSError))
        return float(data.get("km", 0.0))
