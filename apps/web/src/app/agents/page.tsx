'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentForm, type AgentFormBody } from '@/components/agent-form';
import { AgentsTable } from '@/components/agents-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { post } from '@/lib/api';

export default function AgentsPage() {
  const qc = useQueryClient();
  const [formKey, setFormKey] = useState(0);

  const create = async (body: AgentFormBody) => {
    await post('/agents', body);
    setFormKey((k) => k + 1); // remount resets the form
    await qc.invalidateQueries({ queryKey: ['agents'] });
  };

  return (
    <div className="space-y-4">
      <AgentsTable />

      <Card>
        <CardHeader>
          <CardTitle>Create agent</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentForm key={formKey} submitLabel="Create agent" onSubmit={create} />
        </CardContent>
      </Card>
    </div>
  );
}
