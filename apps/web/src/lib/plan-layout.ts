export interface PlanNode {
  id: string;
  dependsOn: string[];
}
export interface Cell {
  col: number;
  row: number;
}

/**
 * Layered layout for a dependency graph: a node's depth is one past its deepest dependency.
 * A depth with more than `maxRows` nodes wraps into further columns, so a flat plan
 * (no dependencies yet) still reads as a grid instead of one tall column.
 * Unknown or cyclic dependencies are ignored for depth.
 */
export function layoutPlan(nodes: PlanNode[], maxRows = 4): Map<string, Cell> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: break it here
    visiting.add(id);
    const node = byId.get(id);
    let d = 0;
    for (const dep of node?.dependsOn ?? []) if (byId.has(dep)) d = Math.max(d, depthOf(dep) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) depthOf(n.id);

  const layers: string[][] = [];
  for (const n of nodes) (layers[depth.get(n.id)!] ??= []).push(n.id);

  const cells = new Map<string, Cell>();
  let col = 0;
  for (const layer of layers) {
    if (!layer) continue;
    layer.forEach((id, i) => cells.set(id, { col: col + Math.floor(i / maxRows), row: i % maxRows }));
    col += Math.ceil(layer.length / maxRows);
  }
  return cells;
}
