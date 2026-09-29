import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/SettingsPage.tsx';
import { DEFAULT_SETTINGS_SECTION, parseSettingsSearch } from '@/features/settings/sections.ts';

export const Route = createFileRoute('/settings')({
  validateSearch: parseSettingsSearch,
  component: SettingsRoute,
});

function SettingsRoute() {
  const { section } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SettingsPage
      section={section ?? DEFAULT_SETTINGS_SECTION}
      onSection={(next) => void navigate({ search: { section: next }, replace: true })}
    />
  );
}
