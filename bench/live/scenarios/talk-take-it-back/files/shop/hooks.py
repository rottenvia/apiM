"""Loads what settings.py names."""
import importlib

from . import settings


def formatter():
    module, name = settings.PRICE_FORMATTER.split(":")
    return getattr(importlib.import_module(module), name)
