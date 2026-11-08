'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { AgentForm, type AgentFormBody } from '@/components/agent-form';
import { AgentsTable } from '@/components/agents-table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { post } from '@/lib/api';

export default function AgentsPage() {
  return (
    <Suspense>
      <Agents />
    </Suspense>
  );
}

/** `?new=1` (the Dashboard's "Create agent") opens the form straight away. */
function Agents() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(useSearchParams().get('new') === '1');

  const create = async (body: AgentFormBody) => {
    await post('/agents', body);
    setCreating(false);
    await qc.invalidateQueries({ queryKey: ['agents'] });
  };

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Agent Studio</PageTitle>
          <PageDescription>Your team. Each agent is a Claude Code or Codex session with its own settings.</PageDescription>
        </div>
        <PageActions>
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden />
            New agent
          </Button>
        </PageActions>
      </PageHeader>
      <AgentsTable />

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[88dvh] max-w-[760px] overflow-y-auto">
          <DialogTitle>New agent</DialogTitle>
          {creating && <AgentForm submitLabel="Create agent" onSubmit={create} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
