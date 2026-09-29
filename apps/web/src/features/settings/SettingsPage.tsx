import { cn } from '@/components/ui/cn.ts';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { AgncConnectCard } from '@/features/agnc/AgncConnectCard.tsx';
import { RemotePanel } from '@/features/remote/RemotePanel.tsx';
import { SecretsHygienePanel } from '@/features/safety/SecretsHygienePanel.tsx';
import { SupervisorSettings } from '@/features/supervisor/SupervisorSettings.tsx';
import { ArchiveSettings } from './ArchiveSettings.tsx';
import { BridgeSettings } from './BridgeSettings.tsx';
import { ConnectorsPanel } from './ConnectorsPanel.tsx';
import { LimitsSettings } from './LimitsSettings.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';
import { RecapSettings } from './RecapSettings.tsx';
import { SettingsCard } from './SettingsCard.tsx';
import { isSettingsSection, SETTINGS_SECTIONS, type SettingsSectionId } from './sections.ts';

function SectionBody({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case 'projects':
      return <ProjectSettings />;
    case 'notifications':
      return <NotificationSettings />;
    case 'recaps':
      return <RecapSettings />;
    case 'limits':
      return <LimitsSettings />;
    case 'supervisor':
      return <SupervisorSettings />;
    case 'connectors':
      return (
        <SettingsCard
          titleId="settings-connectors"
          title="Connectors"
          description="Accounts the app uses for tickets, messages and remote agents. Tokens are kept in the Keychain."
        >
          <ConnectorsPanel />
          <AgncConnectCard />
        </SettingsCard>
      );
    case 'remote':
      return (
        <SettingsCard
          titleId="settings-remote"
          title="Remote & mobile"
          description="Reach the daemon from a phone over Tailscale. Nothing is exposed to the public internet."
        >
          <RemotePanel />
        </SettingsCard>
      );
    case 'advanced':
      return (
        <>
          <ArchiveSettings />
          <BridgeSettings />
          <SecretsHygienePanel />
        </>
      );
  }
}

export function SettingsPage({
  section,
  onSection,
}: {
  section: SettingsSectionId;
  onSection(section: SettingsSectionId): void;
}) {
  const current = SETTINGS_SECTIONS.find((s) => s.id === section);
  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 p-4 pb-8 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Everything the daemon and this app are configured with. Each panel saves on its own.
        </p>
      </header>
      <div className="grid min-w-0 items-start gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0 md:sticky md:top-4">
          <NativeSelect
            aria-label="Settings section"
            className="w-full md:hidden"
            value={section}
            onChange={(e) => {
              if (isSettingsSection(e.target.value)) onSection(e.target.value);
            }}
          >
            {SETTINGS_SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
          <ul className="hidden flex-col gap-0.5 md:flex">
            {SETTINGS_SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={s.id === section ? 'page' : undefined}
                  onClick={() => onSection(s.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
                    s.id === section && 'bg-accent font-medium text-accent-foreground',
                  )}
                >
                  <s.icon className="size-4 shrink-0" aria-hidden />
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-6">
          {current ? (
            <p className="sr-only" aria-live="polite">
              {`${current.label} settings`}
            </p>
          ) : null}
          <SectionBody section={section} />
        </div>
      </div>
    </div>
  );
}
