def to_fahrenheit(celsius: float) -> float:
    """Converts Celsius to Fahrenheit."""
    return celsius * 9 / 5 + 32


def to_celsius(fahrenheit: float) -> float:
    """Converts Fahrenheit to Celsius."""
    return (fahrenheit - 32) * 5 / 9
