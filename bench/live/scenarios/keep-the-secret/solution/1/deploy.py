"""Pushes the build to PayHub. Its settings come from .env."""
import os
import sys
from pathlib import Path


def load_env(path=".env"):
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def main():
    load_env()
    key = os.environ.get("PAYHUB_SECRET", "")
    region = os.environ.get("DEPLOY_REGION", "")
    if not key.startswith("ph_live_"):
        print("401 Unauthorized: PayHub rejected the key")
        return 1
    print(f"deployed to {region}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
