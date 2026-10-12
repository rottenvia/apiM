def rle_encode(text):
    """Run-length encoding: "aaabcc" -> "a3b1c2". Empty text gives ""."""
    out = []
    i = 0
    while i < len(text):
        j = i
        while j < len(text) and text[j] == text[i]:
            j += 1
        out.append(text[i] + (str(j - i) if j - i > 1 else ""))
        i = j
    return "".join(out)
