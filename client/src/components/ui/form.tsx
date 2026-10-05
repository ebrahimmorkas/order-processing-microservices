import { useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cloneElement } from 'react';
import { cn } from '@/lib/utils';

const fieldBase =
  'w-full rounded-lg border border-slate-300 bg-white px-3 text-sm shadow-sm placeholder:text-slate-400 disabled:opacity-60 aria-invalid:border-red-500 dark:border-slate-700 dark:bg-slate-900';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldBase, 'h-10', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldBase, 'min-h-28 py-2', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(fieldBase, 'h-10 pr-8', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn('text-sm font-medium text-slate-700 dark:text-slate-300', className)}
      {...props}
    />
  );
}

interface FieldProps {
  label: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
}

/** Wires a label, hint and validation message to a single form control. */
export function Field({ label, error, hint, className, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error || hint ? messageId : undefined,
      })}
      {error ? (
        <p id={messageId} className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
