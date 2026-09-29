# Configuration

The service reads one JSON file: `--config PATH`, else `$APP_CONFIG`, else
`./config.json`. A missing `./config.json` means "all defaults"; a path given
with `--config` or `$APP_CONFIG` must exist. Invalid JSON or a value of the
wrong type is a config error (exit status 2).

Every key is optional; a missing key or `null` means the default. Unknown
keys are ignored.

| key | type | default | env override |
|-----|------|---------|--------------|
| `server.host` | string | `"127.0.0.1"` | `APP_HOST` |
| `server.port` | integer 1-65535 | `8000` | `APP_PORT` |
| `server.workers` | integer 1-64 or `"auto"` | `"auto"` = max(1, pool_size // 2) | `APP_WORKERS` |
| `server.debug` | boolean | `false` | `APP_DEBUG` (yes/no, on/off, true/false, 1/0) |
| `database.url` | string | `"sqlite:///reports.db"` | `DATABASE_URL` |
| `database.pool_size` | integer 1-100 | `5` | `APP_DB_POOL_SIZE` |
| `database.timeout_seconds` | number > 0 | `30.0` | `APP_DB_TIMEOUT` |
| `features.enabled` | list of strings | `[]` | `APP_FEATURES` (comma separated) |
| `features.beta_users` | list of strings | `[]` | - |
| `logging.level` | string: DEBUG, INFO, WARNING (or WARN), ERROR | `DEBUG` if debug else `INFO` | `APP_LOG_LEVEL` |
| `logging.file` | string or null | `null` (stderr) | `APP_LOG_FILE` |

Environment variables win over the file; an empty variable counts as unset.
Feature names are lower-cased and de-duplicated; beta users are
lower-cased, de-duplicated and sorted.
