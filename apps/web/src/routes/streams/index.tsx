import { createFileRoute } from '@tanstack/react-router';
import { StreamsPage } from '@/features/streams/StreamsPage.tsx';

export const Route = createFileRoute('/streams/')({ component: StreamsPage });
