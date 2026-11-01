"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { TagList } from "@/components/ui/tag-list";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { del } from "@/lib/api";
import { useWorkers, type Worker } from "@/lib/queries";
import { relativeTime } from "@/lib/workers";

function Mode({ w }: { w: Worker }) {
  if (w.status === "pending") return <span className="text-ink-3">—</span>;
  if (w.canClone) return <span>remote</span>;
  return (
    <div>
      <span>local</span>
      {w.allowedRoots.length > 0 && (
        <p className="font-mono text-xs text-ink-3">
          {w.allowedRoots.join(", ")}
        </p>
      )}
    </div>
  );
}

export function WorkersTable() {
  const qc = useQueryClient();
  const workers = useWorkers();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");
  const revoke = async (w: Worker) => {
    if (!window.confirm(`Revoke "${w.name}"? It can no longer connect.`))
      return;
    setBusyId(w.id);
    try {
      await del(`/workers/${w.id}`);
      setError("");
      await qc.invalidateQueries({ queryKey: ["workers"] });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not revoke the worker",
      );
    } finally {
      setBusyId(undefined);
    }
  };
  return (
    <>
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Machine</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Runs</TableHead>
            <TableHead>Last heartbeat</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {workers.data?.map((w) => (
            <TableRow key={w.id}>
              <TableCell>{w.name}</TableCell>
              <TableCell>
                <StatusPill
                  status={
                    w.status === "online" && !w.online ? "offline" : w.status
                  }
                />
              </TableCell>
              <TableCell>
                <Mode w={w} />
              </TableCell>
              <TableCell>
                {w.machineId ? (
                  <span className="font-mono text-xs" title={w.machineId}>
                    {w.machineId.slice(0, 8)}
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                <TagList tags={w.tags} />
              </TableCell>
              <TableCell>
                {w.activeRuns}/{w.capacity}
              </TableCell>
              <TableCell>
                {w.lastHeartbeatAt ? relativeTime(w.lastHeartbeatAt) : "—"}
              </TableCell>
              <TableCell>
                {w.status !== "revoked" && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busyId === w.id}
                    aria-label={`Revoke ${w.name}`}
                    onClick={() => void revoke(w)}
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
