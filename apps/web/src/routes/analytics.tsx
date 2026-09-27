import { createFileRoute } from '@tanstack/react-router';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage.tsx';

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage });
