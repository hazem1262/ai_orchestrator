import { useNavigate } from '@tanstack/react-router';
import { useLaunchStore } from '@/stores/launch.ts';
import { usePaletteStore } from '@/stores/palette.ts';
import { useHotkeys } from './registry.ts';

export function GlobalHotkeys(): null {
  const navigate = useNavigate();
  const togglePalette = usePaletteStore((s) => s.toggle);
  const openLaunch = useLaunchStore((s) => s.show);
  useHotkeys(
    [
      {
        id: 'palette',
        keys: 'mod+k',
        description: 'Command palette',
        group: 'actions',
        handler: togglePalette,
        allowInInputs: true,
      },
      {
        id: 'go-inbox',
        keys: 'g i',
        description: 'Go to inbox',
        group: 'navigation',
        handler: () => void navigate({ to: '/inbox' }),
      },
      {
        id: 'go-waiting',
        keys: 'g w',
        description: 'Show waiting sessions',
        group: 'navigation',
        handler: () => void navigate({ to: '/live', search: { status: 'waiting' } } as never),
      },
      {
        id: 'go-history',
        keys: 'g h',
        description: 'Go to history',
        group: 'navigation',
        handler: () => void navigate({ to: '/history' }),
      },
      {
        id: 'go-audit',
        keys: 'g a',
        description: 'Go to audit log',
        group: 'navigation',
        handler: () => void navigate({ to: '/audit' }),
      },
      {
        id: 'new-session',
        keys: 'n',
        description: 'New session',
        group: 'actions',
        handler: () => openLaunch(),
      },
    ],
    [navigate, togglePalette, openLaunch],
  );
  return null;
}
