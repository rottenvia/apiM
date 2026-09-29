# report service

    python main.py                   # uses ./settings.ini if present
    python main.py --config other.ini
    APP_CONFIG=/etc/reports.ini python main.py

Settings can be overridden with environment variables (APP_PORT,
DATABASE_URL, ...); see app/settings.py.
