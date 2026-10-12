"""Named handlers of the chat bot."""

_handlers = {}


def register(name, handler):
    """Adds a handler. A name can be registered once."""
    if name in _handlers:
        raise KeyError(f"{name} is already registered")
    _handlers[name] = handler


def names():
    return sorted(_handlers)


def dispatch(name, *args):
    return _handlers[name](*args)


def clear():
    """Forgets every handler (tests call this)."""
    _handlers.clear()
