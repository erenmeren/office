import { AuditTable } from '@/components/audit-table';
import { PageHeader, PageTitle } from '@/components/ui/page-header';

export default function Page() {
  return (
    <>
      <PageHeader>
        <PageTitle>Audit</PageTitle>
      </PageHeader>
      <AuditTable />
    </>
  );
}
