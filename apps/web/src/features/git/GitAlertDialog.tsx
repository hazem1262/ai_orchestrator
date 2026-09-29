import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { useFocusReturn } from '@/components/ui/use-focus-return.ts';

/**
 * The confirm frame for daemon `409 confirmation_required` prompts: an `alertdialog` the caller
 * mounts to open and unmounts to close. Escape calls `onClose` (a click outside does not), and
 * focus returns to the opener. `footer` holds the Cancel / confirm buttons.
 */
export function GitAlertDialog({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const returnFocus = useFocusReturn(true);
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={returnFocus}
        {...(description ? {} : { 'aria-describedby': undefined })}
        className="top-8 max-h-[calc(100%-4rem)] translate-y-0 gap-3 overflow-auto data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-lg"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-semibold">{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>{footer}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
