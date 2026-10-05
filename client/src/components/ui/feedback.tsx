import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './button';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div role="status" className={cn('flex justify-center py-16 text-slate-400', className)}>
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800', className)} />
  );
}

interface StateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: StateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-xl border border-dashed border-slate-300 px-6 py-14 text-center dark:border-slate-700',
        className,
      )}
    >
      <Inbox className="mb-3 size-10 text-slate-400" aria-hidden />
      <h3 className="font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center rounded-xl border border-red-200 bg-red-50 px-6 py-12 text-center dark:border-red-900 dark:bg-red-950/40"
    >
      <AlertTriangle className="mb-3 size-9 text-red-500" aria-hidden />
      <h3 className="font-semibold">Something went wrong</h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Alert({
  children,
  tone = 'danger',
}: {
  children: ReactNode;
  tone?: 'danger' | 'info';
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        tone === 'danger'
          ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
          : 'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-100',
      )}
    >
      {children}
    </div>
  );
}
