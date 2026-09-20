import { createContext, type ReactNode, useContext, useId, useState } from 'react';
import { cn } from './cn.ts';

interface TabsContextValue {
  value: string;
  setValue(v: string): void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used inside <Tabs>');
  return ctx;
}

export function Tabs(props: {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  className?: string;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(props.defaultValue ?? '');
  const baseId = useId();
  const value = props.value ?? inner;
  const setValue = (v: string) => {
    setInner(v);
    props.onValueChange?.(v);
  };
  return (
    <TabsContext.Provider value={{ value, setValue, baseId }}>
      <div className={props.className}>{props.children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div role="tablist" className={cn('inline-flex gap-1 border-b', className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.baseId}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${tabs.baseId}-panel-${value}`}
      onClick={() => tabs.setValue(value)}
      className={cn(
        '-mb-px border-b-2 px-3 py-1.5 text-sm',
        active ? 'border-primary font-medium' : 'border-transparent',
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${tabs.baseId}-panel-${value}`}
      aria-labelledby={`${tabs.baseId}-tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
