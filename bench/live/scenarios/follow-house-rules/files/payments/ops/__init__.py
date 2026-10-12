"""Every operation the API can call, by name."""
from .capture import capture
from .charge import charge

REGISTRY = {"charge": charge, "capture": capture}
