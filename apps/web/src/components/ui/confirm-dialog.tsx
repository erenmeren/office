'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** red confirm button for deletes, cancels and revocations */
  destructive?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(() => Promise.resolve(false));

/** In-app replacement for `window.confirm`: resolves true when the owner confirms, false on cancel, Escape or backdrop. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void }>();
  const ask = useCallback<Ask>((options) => new Promise((resolve) => setPending({ options, resolve })), []);
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(undefined);
  };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog open={!!pending} onOpenChange={(open) => !open && settle(false)}>
        <DialogContent role="alertdialog">
          {pending && (
            <>
              <DialogTitle>{pending.options.title}</DialogTitle>
              {pending.options.body && <p className="mb-4 text-sm text-ink-2">{pending.options.body}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => settle(false)}>
                  Cancel
                </Button>
                <Button variant={pending.options.destructive ? 'destructive' : 'default'} autoFocus onClick={() => settle(true)}>
                  {pending.options.confirmLabel ?? 'Confirm'}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
