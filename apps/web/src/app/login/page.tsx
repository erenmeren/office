'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, post } from '@/lib/api';
import { useMe } from '@/lib/queries';

export default function LoginPage() {
  const me = useMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const setup = me.data?.setupRequired === true;

  useEffect(() => {
    if (me.data && !me.data.setupRequired) window.location.assign('/');
  }, [me.data]);

  if (me.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await post(setup ? '/auth/setup' : '/auth/login', { email, password });
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Invalid email or password' : String(err));
    }
  };

  return (
    <Card className="mx-auto mt-16 max-w-sm">
      <CardHeader>
        <CardTitle>{setup ? 'Create the owner account' : 'Log in'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={setup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full">
            {setup ? 'Create account' : 'Log in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
