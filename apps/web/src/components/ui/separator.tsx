import { cn } from './cn.ts';

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return (
    <hr
      aria-orientation={orientation}
      className={cn(
        'border-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  );
}
