import { Separator } from '@/components/ui/separator.tsx';
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

export function SettingsPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-4 pb-8">
      <ProjectSettings />
      <div className="flex flex-col gap-4 px-4">
        <Separator />
        <ArchiveSettings />
        <Separator />
        <NotificationSettings />
        <Separator />
        <RecapSettings />
        <Separator />
        <LimitsSettings />
        <Separator />
        <BridgeSettings />
        <Separator />
        <SecretsHygienePanel />
        <Separator />
        <SupervisorSettings />
        <Separator />
        <section aria-labelledby="settings-connectors" className="flex flex-col gap-2">
          <h2 id="settings-connectors" className="text-base font-semibold">
            Connectors
          </h2>
          <ConnectorsPanel />
          <AgncConnectCard />
        </section>
        <Separator />
        <section aria-labelledby="settings-remote" className="flex flex-col gap-2">
          <h2 id="settings-remote" className="text-base font-semibold">
            Remote &amp; mobile
          </h2>
          <RemotePanel />
        </section>
      </div>
    </div>
  );
}
