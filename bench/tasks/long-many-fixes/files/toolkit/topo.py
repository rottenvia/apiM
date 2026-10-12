def topo_sort(graph):
    """An order of the nodes with every node after all it depends on. graph maps a node to the list of nodes it depends on;
    a node named only as a dependency counts too. Among nodes that are free at the same time, the smaller name comes first. A cycle raises ValueError."""
    nodes = set(graph) | {d for deps in graph.values() for d in deps}
    done, out = set(), []
    while len(out) < len(nodes):
        free = sorted(n for n in nodes - done if all(d in done for d in graph.get(n, [])))
        if not free:
            return out
        out.append(free[0])
        done.add(free[0])
    return out
