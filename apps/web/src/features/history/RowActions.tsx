import { HIDDEN_LABEL, type SessionListItem } from '@orc/api-contract';
import { EyeOff, MoreHorizontal, Tag } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useSetLabels } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { ResumeActions } from '@/features/terminal/ResumeActions.tsx';
import { titleOf } from './parts.tsx';

function IconTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Resume is the one verb every row needs, so it stays a button; Labels and Hide move behind a
 * "More actions" menu so the Session title keeps its width on a phone (audit F8/F21 pattern).
 */
export function RowActions({ item }: { item: SessionListItem }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const setLabels = useSetLabels();
  const title = titleOf(item);
  const hidden = item.labels.includes(HIDDEN_LABEL);

  if (editing) {
    const save = (e: FormEvent) => {
      e.preventDefault();
      const next = value
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);
      const keep = hidden ? [HIDDEN_LABEL] : [];
      setLabels.mutate({ source: item.source, id: item.id, labels: [...new Set([...next, ...keep])] });
      setEditing(false);
    };
    return (
      <form onSubmit={save} className="flex items-center justify-end gap-1">
        <Input
          aria-label="Labels"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-7 w-28"
        />
        <Button size="sm" type="submit">
          Save
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <ResumeActions
        compact
        target={{
          source: item.source,
          id: item.id,
          availability: item.availability,
          live: item.live,
          title,
        }}
      />
      <DropdownMenu>
        <IconTip label="More actions">
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
        </IconTip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setValue(item.labels.filter((l) => l !== HIDDEN_LABEL).join(', '));
              setEditing(true);
            }}
          >
            <Tag />
            Edit labels…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              const labels = hidden
                ? item.labels.filter((l) => l !== HIDDEN_LABEL)
                : [...item.labels, HIDDEN_LABEL];
              setLabels.mutate({ source: item.source, id: item.id, labels });
            }}
          >
            <EyeOff />
            {hidden ? 'Unhide' : 'Hide'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
