import { formatMs, formatTokens } from './format.ts';
import type { ToolStep } from './group-events.ts';

const MAX_OUTPUT = 20_000;

export function StepInspector({ step, onClose }: { step: ToolStep; onClose: () => void }) {
  const { call, result } = step;
  const duration = result ? Math.max(0, Date.parse(result.ts) - Date.parse(call.ts)) : null;
  const u = call.usage;
  return (
    <aside
      aria-label="Step inspector"
      className="w-[420px] shrink-0 overflow-auto border-l border-neutral-200 p-3 text-sm"
    >
      <header className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{call.tool ?? 'tool'}</h3>
        <button type="button" aria-label="Close inspector" onClick={onClose} className="px-2">
          ×
        </button>
      </header>
      <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1">
        <dt>Started</dt>
        <dd>{new Date(call.ts).toLocaleTimeString()}</dd>
        <dt>Duration</dt>
        <dd>{result ? formatMs(duration) : 'no result yet'}</dd>
        <dt>Model</dt>
        <dd>{call.model ?? '—'}</dd>
        <dt>Tokens</dt>
        <dd>
          {u
            ? `in ${formatTokens(u.input)} · out ${formatTokens(u.output)} · cache read ${formatTokens(u.cacheRead)} · cache write ${formatTokens(u.cacheWrite)}`
            : 'counted on the first block of this message'}
        </dd>
        {call.mcpServer && (
          <>
            <dt>MCP server</dt>
            <dd>{call.mcpServer}</dd>
          </>
        )}
        {result?.kind === 'error' || result?.text?.trimStart().startsWith('<tool_use_error>') ? (
          <>
            <dt>Status</dt>
            <dd className="text-red-600">failed</dd>
          </>
        ) : null}
      </dl>
      <h4 className="mt-3 font-medium">Input</h4>
      <pre data-testid="step-input" className="whitespace-pre-wrap break-all rounded bg-neutral-50 p-2">
        {JSON.stringify(call.input, null, 2)}
      </pre>
      <h4 className="mt-3 font-medium">Output</h4>
      <pre data-testid="step-output" className="whitespace-pre-wrap break-all rounded bg-neutral-50 p-2">
        {result?.text ? result.text.slice(0, MAX_OUTPUT) : '—'}
      </pre>
    </aside>
  );
}
