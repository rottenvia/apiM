"""Domain errors. HTTP status codes for these live in fleetdesk/http/errors.py."""


class FleetError(Exception):
    """Base class for all domain errors."""


class NotFoundError(FleetError):
    def __init__(self, kind: str, ident):
        super().__init__(f"{kind} {ident} not found")
        self.kind, self.ident = kind, ident


class ConflictError(FleetError):
    """The request conflicts with the current state (e.g. a concurrent update)."""


class ValidationError(FleetError):
    def __init__(self, message: str, field: str | None = None):
        super().__init__(message)
        self.field = field


class RegistrationError(ValidationError):
    """A vehicle or driver could not be registered."""


class InvalidVinError(RegistrationError):
    def __init__(self, vin):
        super().__init__(f"invalid VIN {vin!r}", field="vin")


class DuplicateVinError(RegistrationError):
    def __init__(self, vin):
        super().__init__(f"a vehicle with VIN {vin} is already registered", field="vin")


class LicenseError(RegistrationError):
    pass


class AuthenticationError(FleetError):
    pass


class PermissionDenied(FleetError):
    pass


class StateError(ConflictError):
    """An operation is not allowed in the entity's current state."""
