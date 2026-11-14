'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ModelItems } from '@/components/model-items';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';
import { frontmatterModel, skillErrorText, withFrontmatterModel } from '@/lib/skills';

const TEMPLATE =
  '---\nname: my-skill\ndescription: One line on when to use this skill\n---\n\n# My skill\n\n## When to use\n\n## Steps\n\n## Done when\n';

function useSubmit(onDone?: () => void) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['skills'] });
      onDone?.();
    } catch (err) {
      setError(skillErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

/** "Import from folder": a directory under the API's skill import roots. */
export function ImportFolderForm({ onDone }: { onDone?: () => void }) {
  const [path, setPath] = useState('');
  const { error, busy, submit } = useSubmit(onDone);
  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit(() => post('/skills/import', { source: 'local', path }));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from folder</CardTitle>
        <CardDescription>A directory holding a SKILL.md, under the configured import roots. The skill waits for review.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={go} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="impPath">Path</Label>
            <Input id="impPath" required value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/skills/my-skill" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>
            Import
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** "Import from Git": an https repository, optional ref, and either a path or the skill's frontmatter name. */
export function ImportGitForm({ onDone }: { onDone?: () => void }) {
  const [f, setF] = useState({ url: '', ref: '', path: '', name: '' });
  const { error, busy, submit } = useSubmit(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit(() =>
      post('/skills/import', {
        source: 'git',
        url: f.url,
        ref: f.ref || undefined,
        path: f.path || undefined,
        name: !f.path && f.name ? f.name : undefined,
      }),
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from Git</CardTitle>
        <CardDescription>Cloned once at import; Update re-reads the same url, ref and path later. The skill waits for review.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={go} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="impUrl">Repository URL (https)</Label>
            <Input id="impUrl" required value={f.url} onChange={set('url')} placeholder="https://github.com/owner/repo" />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="impRef">Ref (optional)</Label>
              <Input id="impRef" value={f.ref} onChange={set('ref')} placeholder="main" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="impGitPath">Path in repo (optional)</Label>
              <Input id="impGitPath" value={f.path} onChange={set('path')} placeholder="skills/my-skill" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="impName">Or skill name (optional)</Label>
              <Input id="impName" value={f.name} onChange={set('name')} placeholder="my-skill" disabled={!!f.path} />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>
            Import
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** "New skill": name, model (written into the frontmatter) and the SKILL.md text; created approved. */
export function NewSkillForm({ onDone }: { onDone?: () => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState(TEMPLATE);
  const { error, busy, submit } = useSubmit(onDone);
  const model = frontmatterModel(text);
  const go = (e: FormEvent) => {
    e.preventDefault();
    void submit(async () => {
      await post('/skills', { name, files: { 'SKILL.md': text } });
      setName('');
      setText(TEMPLATE);
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>New skill</CardTitle>
        <CardDescription>Written here, approved on creation. The model is optional: without one the skill runs on the agent&rsquo;s model.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={go} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="skillName">Name</Label>
              <Input id="skillName" required value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" />
            </div>
            <div className="space-y-1">
              <Label>Model</Label>
              <Select value={model || 'inherit'} onValueChange={(v) => setText(withFrontmatterModel(text, v === 'inherit' ? '' : String(v)))}>
                <SelectTrigger className="w-full" aria-label="Skill model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">inherit</SelectItem>
                  <ModelItems current={model} />
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="skillMd">SKILL.md</Label>
            <Textarea id="skillMd" rows={14} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>
            Create skill
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
