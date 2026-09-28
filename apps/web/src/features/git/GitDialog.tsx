import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { useFocusReturn } from '@/components/ui/use-focus-return.ts';

/**
 * The modal frame the phase 4 git dialogs share. The caller mounts it to open it and unmounts it
 * to close it; Escape and a click outside call `onClose`, and focus returns to the opener.
 */
export function GitDialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const returnFocus = useFocusReturn(true);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={returnFocus}
        {...(description ? {} : { 'aria-describedby': undefined })}
        className="top-8 max-h-[calc(100%-4rem)] translate-y-0 gap-3 overflow-auto sm:max-w-lg"
      >
        <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {children}
      </DialogContent>
    </Dialog>
  );
}
