'use client';

import { Decisions } from '@/components/decisions';
import { PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';

export default function DecisionsPage() {
  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Decisions</PageTitle>
          <PageDescription>Everything that waits for you, in one place: plans, tool requests, blocked tasks, skill imports and memory proposals.</PageDescription>
        </div>
      </PageHeader>
      <Decisions />
    </div>
  );
}
