'use client';

import { Suspense } from 'react';
import { SettingsForm } from '@/components/settings-form';
import { useProject } from '@/lib/project';
import { useProjectAgents, useProjectSettings } from '@/lib/queries';
import { useMounted } from '@/lib/use-mounted';

function SettingsView() {
  const mounted = useMounted();
  const project = useProject();
  const settings = useProjectSettings(project?.id).data;
  const agents = useProjectAgents(project?.id).data;
  if (!mounted || !project || !settings || !agents) return null;
  return <SettingsForm projectId={project.id} settings={settings} agentIds={agents.map((a) => a.id)} />;
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
