def rle_encode(text):
    """Run-length encoding: "aaabcc" -> "a3b1c2". Empty text gives ""."""
    out = []
    i = 0
    while i < len(text):
        j = i
        while j < len(text) and text[j] == text[i]:
            j += 1
        out.append(f"{text[i]}{j - i}")
        i = j
    return "".join(out)
