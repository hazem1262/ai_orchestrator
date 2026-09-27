import { Separator } from '@/components/ui/separator.tsx';
import { SecretsHygienePanel } from '@/features/safety/SecretsHygienePanel.tsx';
import { ArchiveSettings } from './ArchiveSettings.tsx';
import { BridgeSettings } from './BridgeSettings.tsx';
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
      </div>
    </div>
  );
}
