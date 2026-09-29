import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';

export function CommentComposer({ onSubmit, onCancel }: { onSubmit(body: string): void; onCancel(): void }) {
  const [body, setBody] = useState('');
  return (
    <div className="space-y-1 border-y bg-muted p-2">
      <Textarea
        aria-label="Comment"
        className="bg-background"
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
