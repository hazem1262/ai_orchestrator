import type { ChainStepView } from './conductor.ts';

const TONE: Record<ChainStepView['status'], string> = {
  pending: 'border-dashed border-neutral-300 text-neutral-400',
  running: 'border-sky-400 bg-sky-50',
  done: 'border-emerald-400 bg-emerald-50',
  error: 'border-red-400 bg-red-50',
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
            <button
              key={a.id}
              type="button"
              className="block truncate underline"
              onClick={() => onOpenAgent(a.id)}
            >
              {a.description || a.agentType}
            </button>
          ))}
        </li>
      ))}
    </ol>
  );
}
