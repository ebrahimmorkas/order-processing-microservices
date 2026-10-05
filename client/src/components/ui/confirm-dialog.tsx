import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './button';

interface Props {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Built on the native <dialog> element, which handles focus trapping and Esc for free. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'danger',
  loading,
  onConfirm,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="confirm-title"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl bg-white p-6 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:bg-slate-900 dark:text-slate-100"
    >
      {open && (
        <>
          <h2 id="confirm-title" className="text-lg font-semibold">
            {title}
          </h2>
          <div className="mt-2 text-sm text-slate-600 dark:text-slate-400">{description}</div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Keep it
            </Button>
            <Button variant={tone} onClick={onConfirm} loading={loading}>
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
