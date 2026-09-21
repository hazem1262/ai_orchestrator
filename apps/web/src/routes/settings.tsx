import { createFileRoute } from '@tanstack/react-router';
import { ProjectSettings } from '@/features/settings/ProjectSettings.tsx';

export const Route = createFileRoute('/settings')({ component: ProjectSettings });
