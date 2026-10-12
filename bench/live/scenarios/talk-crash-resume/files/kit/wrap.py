def wrap(text, width):
    """Breaks text at spaces into lines of at most `width` characters."""
    lines, line = [], ""
    for word in text.split():
        if line and len(line) + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        lines.append(line)
    return lines
