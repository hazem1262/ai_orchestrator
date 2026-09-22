import { Separator } from '@/components/ui/separator.tsx';
import { ArchiveSettings } from './ArchiveSettings.tsx';
import { HookSetup } from './HookSetup.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';

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
        <HookSetup />
      </div>
    </div>
  );
}
