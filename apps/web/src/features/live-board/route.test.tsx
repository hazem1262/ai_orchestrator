import { screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { Route } from '../../routes/live.tsx';
import { useLiveLayoutStore } from '../../stores/live-layout.ts';
import { useProjectStore } from '../../stores/project.ts';
import { liveSessionFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';

beforeEach(() => {
  useLiveLayoutStore.setState({ layout: 'grid', pinned: [], groupBy: 'none', openInByProject: {} });
  useProjectStore.setState({ projectId: 'all' });
});

afterEach(() => setApiClientForTests(null));

describe('/live route', () => {
  it('renders the live board', async () => {
    const liveList = vi.fn(async () => [
      liveSessionFixture({ id: 'a', name: 'Alpha' }, { status: 'waiting' }),
    ]);
    const Component = Route.options.component as unknown as ComponentType;
    expect(Component).toBeTruthy();
    renderWithProviders(<Component />, { api: createFakeApi({ liveList }), path: '/live' });
    expect(await screen.findByRole('article', { name: 'Alpha — Waiting' })).toBeTruthy();
    expect(liveList).toHaveBeenCalled();
  });
});
