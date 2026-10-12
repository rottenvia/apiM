"""Every operation the API can call, by name."""
from .capture import capture
from .charge import charge
from .refund import refund

REGISTRY = {"charge": charge, "capture": capture, "refund": refund}
