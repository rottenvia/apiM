def wrap_text(text, width):
    """The words of text on lines of at most width characters, as many words per line as fit. A word longer than width gets a line of its own."""
    lines, line = [], ""
    for word in text.split():
        if line and len(line) + 1 + len(word) >= width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    if line:
        lines.append(line)
    return lines
