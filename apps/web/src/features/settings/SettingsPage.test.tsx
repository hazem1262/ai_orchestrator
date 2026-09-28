import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { Route as SettingsRoute } from '../../routes/settings.tsx';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { parseSettingsSearch } from './sections.ts';

afterEach(cleanup);

describe('parseSettingsSearch', () => {
  it('keeps a known section and drops anything else', () => {
    expect(parseSettingsSearch({ section: 'limits' })).toEqual({ section: 'limits' });
    expect(parseSettingsSearch({ section: 'bogus' })).toEqual({});
    expect(parseSettingsSearch({ section: 3 })).toEqual({});
    expect(parseSettingsSearch({})).toEqual({});
  });
});

describe('SettingsPage', () => {
  it('shows the Settings title and only the selected section', async () => {
    renderWithProviders(<SettingsPage section="advanced" onSection={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Transcript archive' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Real-time bridge' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Secrets hygiene' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Projects' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('Archive & advanced');
  });

  it('picks a section from the side nav', async () => {
    const onSection = vi.fn();
    renderWithProviders(<SettingsPage section="projects" onSection={onSection} />);
    await userEvent.click(screen.getByRole('button', { name: 'Limits & budgets' }));
    expect(onSection).toHaveBeenCalledWith('limits');
  });

  it('picks a section from the phone picker', async () => {
    const onSection = vi.fn();
    renderWithProviders(<SettingsPage section="projects" onSection={onSection} />);
    const picker = screen.getByRole('combobox', { name: 'Settings section' });
    expect(picker).toHaveProperty('value', 'projects');
    await userEvent.selectOptions(picker, 'remote');
    expect(onSection).toHaveBeenCalledWith('remote');
  });
});

describe('/settings route', () => {
  function renderAt(url: string) {
    setApiClientForTests(createFakeApi());
    const root = createRootRoute({ component: () => <Outlet /> });
    const settings = SettingsRoute.update({
      id: '/settings',
      path: '/settings',
      getParentRoute: () => root,
    } as never);
    const router = createRouter({
      routeTree: root.addChildren([settings]),
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return router;
  }

  it('opens the section named by ?section= and writes the choice back to the URL', async () => {
    const router = renderAt('/settings?section=limits');
    expect(await screen.findByRole('heading', { level: 2, name: 'Limits & budgets' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Recaps' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ section: 'recaps' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'LLM recaps' })).toBeTruthy();
  });

  it('falls back to Projects for an unknown section', async () => {
    renderAt('/settings?section=nope');
    expect(await screen.findByRole('heading', { level: 2, name: 'Projects' })).toBeTruthy();
  });
});
