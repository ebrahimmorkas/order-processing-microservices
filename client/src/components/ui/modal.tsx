import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './button';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Native <dialog>: focus trapping, Esc to close and inert background for free. */
export function Modal({ open, title, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:bg-slate-900 dark:text-slate-100"
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
