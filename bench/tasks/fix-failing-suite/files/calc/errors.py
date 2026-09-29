class CalcError(Exception):
    """Any error raised while parsing or evaluating an expression."""


class CalcSyntaxError(CalcError):
    def __init__(self, message: str, pos: int):
        super().__init__(f"{message} at position {pos}")
        self.pos = pos
