def rotate(matrix):
    """The matrix (a list of rows) turned a quarter turn clockwise: [[1, 2], [3, 4]] -> [[3, 1], [4, 2]]."""
    return [list(row) for row in zip(*matrix)][::-1]
