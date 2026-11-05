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
import { ApiError, del } from "@/lib/api";
import { useWorkers, type Worker } from "@/lib/queries";
import { relativeTime } from "@/lib/workers";
import { useConfirm } from '@/components/ui/confirm-dialog';

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
  const confirm = useConfirm();
  const remove = async (w: Worker, purge: boolean) => {
    const verb = purge ? 'Delete' : 'Revoke';
    const body = purge ? 'The worker is removed for good. Its finished runs stay.' : 'It can no longer connect.';
    if (!(await confirm({ title: `${verb} "${w.name}"?`, body, confirmLabel: verb, destructive: true }))) return;
    setBusyId(w.id);
    try {
      await del(`/workers/${w.id}${purge ? '?purge=true' : ''}`);
      setError("");
      await qc.invalidateQueries({ queryKey: ["workers"] });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? `"${w.name}" still has a live run. Cancel it first.`
          : err instanceof Error ? err.message : `Could not ${verb.toLowerCase()} the worker`,
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
                <div className="flex justify-end gap-2">
                  {w.status !== "revoked" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === w.id}
                      aria-label={`Revoke ${w.name}`}
                      onClick={() => void remove(w, false)}
                    >
                      Revoke
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busyId === w.id}
                    aria-label={`Delete ${w.name}`}
                    onClick={() => void remove(w, true)}
                  >
                    Delete
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
