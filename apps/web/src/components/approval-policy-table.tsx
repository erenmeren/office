import { useState } from 'react';
import type { ProjectSettings } from '@office/shared';
import { Field } from '@/components/ui/field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { linesToList, listToLines, policyRows } from '@/lib/settings';

type Policy = ProjectSettings['approvalPolicy'];

// Keeps the raw text locally so blank lines survive while typing; the parent gets the cleaned list.
function PatternsField({ id, label, list, onChange }: { id: string; label: string; list: string[]; onChange: (list: string[]) => void }) {
  const [text, setText] = useState(listToLines(list));
  return (
    <Field label={label} htmlFor={id} hint="One pattern per line.">
      <Textarea
        id={id}
        className="font-mono"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(linesToList(e.target.value));
        }}
      />
    </Field>
  );
}

export function ApprovalPolicyTable({ policy, onChange }: { policy: Policy; onChange: (next: Policy) => void }) {
  return (
    <div data-slot="approval-policy-table" className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Action</TableHead>
            <TableHead>When an agent tries it</TableHead>
            <TableHead>Applies to</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {policyRows.map((row) => (
            <TableRow key={row.keys.join('+')}>
              <TableCell>
                <div className="font-medium">{row.label}</div>
                <div className="text-xs text-ink-3">{row.hint}</div>
              </TableCell>
              <TableCell>
                <ToggleGroup
                  label={row.label}
                  value={policy[row.keys[0]]}
                  onChange={(mode) => onChange({ ...policy, ...Object.fromEntries(row.keys.map((k) => [k, mode])) })}
                />
              </TableCell>
              <TableCell className="text-ink-2">{row.applies}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="grid gap-4 md:grid-cols-2">
        <PatternsField id="destructive-patterns" label="Destructive patterns" list={policy.destructivePatterns} onChange={(list) => onChange({ ...policy, destructivePatterns: list })} />
        <PatternsField id="sensitive-paths" label="Sensitive paths" list={policy.sensitivePaths} onChange={(list) => onChange({ ...policy, sensitivePaths: list })} />
      </div>
    </div>
  );
}
