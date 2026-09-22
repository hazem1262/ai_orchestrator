import { screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { Route } from '../../routes/inbox.tsx';
import { useProjectStore } from '../../stores/project.ts';
import { inboxItemFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';

beforeEach(() => {
  useProjectStore.setState({ projectId: 'all' });
});

afterEach(() => setApiClientForTests(null));

describe('/inbox route', () => {
  it('renders the inbox page', async () => {
    const inboxList = vi.fn(async () => [
      inboxItemFixture({ id: 'a', reason: 'Alpha: waiting — input needed' }),
    ]);
    const Component = Route.options.component as unknown as ComponentType;
    expect(Component).toBeTruthy();
    renderWithProviders(<Component />, { api: createFakeApi({ inboxList }), path: '/inbox' });
    expect(await screen.findByText('Alpha: waiting — input needed')).toBeTruthy();
    expect(inboxList).toHaveBeenCalled();
  });
});
