'use client';

import { TASK_NODE, TaskNode } from '@/components/ui/task-node';
import { layoutPlan } from '@/lib/plan-layout';
import { statusTone } from '@/lib/status';

export interface PlanGraphNode {
  id: string;
  code: string;
  title: string;
  assignee?: string;
  status: string;
  dependsOn: string[];
}

const GAP_X = 48;
const GAP_Y = 16;

/** Dependency graph of a plan: columns are depth, arrows run from a dependency to its dependent. */
export function PlanGraph({ nodes, selectedId, onSelect }: { nodes: PlanGraphNode[]; selectedId?: string; onSelect: (id: string) => void }) {
  if (nodes.length === 0) return <p className="text-sm text-muted-foreground">No tasks yet. Send a request to Chief.</p>;
  const cells = layoutPlan(nodes);
  const pos = (id: string) => {
    const c = cells.get(id)!;
    return { x: c.col * (TASK_NODE.w + GAP_X), y: c.row * (TASK_NODE.h + GAP_Y) };
  };
  const cols = Math.max(...[...cells.values()].map((c) => c.col)) + 1;
  const rows = Math.max(...[...cells.values()].map((c) => c.row)) + 1;
  const width = cols * (TASK_NODE.w + GAP_X) - GAP_X;
  const height = rows * (TASK_NODE.h + GAP_Y) - GAP_Y;
  const edges = nodes.flatMap((n) =>
    n.dependsOn
      .filter((d) => cells.has(d))
      .map((d) => {
        const a = pos(d);
        const b = pos(n.id);
        const x1 = a.x + TASK_NODE.w;
        const y1 = a.y + TASK_NODE.h / 2;
        const x2 = b.x;
        const y2 = b.y + TASK_NODE.h / 2;
        return { key: `${d}->${n.id}`, d: `M${x1} ${y1} C${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}` };
      }),
  );

  return (
    <div className="overflow-x-auto py-1">
      <div className="relative" style={{ width, height }}>
        <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height}>
          <defs>
            <marker id="plan-arrow" orient="auto" markerWidth="5" markerHeight="5" refX="4" refY="2.5">
              <path d="M0 0 L5 2.5 L0 5 Z" fill="rgb(255 255 255 / 0.45)" />
            </marker>
          </defs>
          {edges.map((e) => (
            <path key={e.key} d={e.d} fill="none" stroke="rgb(255 255 255 / 0.3)" strokeWidth="1.5" markerEnd="url(#plan-arrow)" />
          ))}
        </svg>
        {nodes.map((n) => {
          const p = pos(n.id);
          return (
            <TaskNode
              key={n.id}
              code={n.code}
              title={n.title}
              assignee={n.assignee}
              tone={statusTone(n.status)}
              selected={n.id === selectedId}
              onClick={() => onSelect(n.id)}
              className="absolute"
              style={{ left: p.x, top: p.y }}
            />
          );
        })}
      </div>
    </div>
  );
}
