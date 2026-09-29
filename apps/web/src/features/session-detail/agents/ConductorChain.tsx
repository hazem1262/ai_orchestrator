import { Button } from '@/components/ui/button.tsx';
import type { ChainStepView } from './conductor.ts';

const TONE: Record<ChainStepView['status'], string> = {
  pending: 'border-dashed border-border text-muted-foreground',
  running: 'border-info/60 bg-info/10',
  done: 'border-success/60 bg-success/10',
  error: 'border-destructive/60 bg-destructive/10',
};

export function ConductorChain({
  chain,
  onOpenAgent,
}: {
  chain: ChainStepView[];
  onOpenAgent: (id: string) => void;
}) {
  return (
    <ol aria-label="Conductor chain" className="flex flex-wrap gap-2 p-3">
      {chain.map((s, i) => (
        <li
          key={s.step}
          data-status={s.status}
          className={`min-w-[130px] rounded border p-2 text-xs ${TONE[s.status]}`}
        >
          <div className="font-medium">
            {i + 1}. {s.step}
          </div>
          <div>{s.status}</div>
          {s.agents.map((a) => (
            <Button
              key={a.id}
              variant="link"
              className="block h-auto truncate p-0 text-left text-foreground underline"
              onClick={() => onOpenAgent(a.id)}
            >
              {a.description || a.agentType}
            </Button>
          ))}
        </li>
      ))}
    </ol>
  );
}
