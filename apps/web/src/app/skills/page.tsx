'use client';

import { useState } from 'react';
import { ImportFolderForm, ImportGitForm, NewSkillForm } from '@/components/skill-forms';
import { SkillMarket } from '@/components/skill-market';
import { SkillsOnMachine } from '@/components/skills-on-machine';
import { SkillReviewBanners } from '@/components/skill-review-banner';
import { SkillsTable } from '@/components/skills-table';
import { Button } from '@/components/ui/button';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';

type Panel = 'machine' | 'folder' | 'git' | 'market' | 'new';
const ACTIONS: [Panel, string][] = [
  ['machine', 'On this machine'],
  ['folder', 'Import from folder'],
  ['git', 'Import from Git'],
  ['market', 'Marketplace'],
  ['new', 'New skill'],
];

export default function SkillsPage() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const close = () => setPanel(null);
  return (
    <div className="space-y-4">
      <PageHeader>
        <div>
          <PageTitle>Skill Library</PageTitle>
          <PageDescription>Skills are assigned to agents permanently. Each session gets the exact versions its agent had when it started.</PageDescription>
        </div>
        <PageActions>
          {ACTIONS.map(([p, label]) => (
            <Button key={p} variant={panel === p ? 'default' : p === 'new' ? 'secondary' : 'outline'} aria-pressed={panel === p} onClick={() => setPanel(panel === p ? null : p)}>
              {label}
            </Button>
          ))}
        </PageActions>
      </PageHeader>
      {panel === 'machine' && <SkillsOnMachine />}
      {panel === 'folder' && <ImportFolderForm onDone={close} />}
      {panel === 'git' && <ImportGitForm onDone={close} />}
      {panel === 'market' && <SkillMarket />}
      {panel === 'new' && <NewSkillForm onDone={close} />}
      <SkillReviewBanners />
      <SkillsTable />
    </div>
  );
}
