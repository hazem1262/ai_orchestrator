import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';

export function CommentComposer({ onSubmit, onCancel }: { onSubmit(body: string): void; onCancel(): void }) {
  const [body, setBody] = useState('');
  return (
    <div className="space-y-1 border-y bg-muted p-2">
      <textarea
        aria-label="Comment"
        className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex gap-1">
        <Button size="sm" disabled={body.trim() === ''} onClick={() => onSubmit(body.trim())}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
