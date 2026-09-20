import { ApiRequestError, ProjectConfig } from '@orc/api-contract';
import type { Project } from '@orc/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';

const projects: Project[] = [
  {
    id: 'wakecap',
    name: 'Wakecap',
    pathPrefixes: ['/Users/test/Wakecap'],
    hidden: false,
    lastActivityAt: null,
    sessionCount: 5,
  },
  {
    id: 'forza',
    name: 'Forza',
    pathPrefixes: ['/Users/test/Forza'],
    hidden: false,
    lastActivityAt: null,
    sessionCount: 1,
  },
];
const configs: Record<string, ProjectConfig> = {
  wakecap: ProjectConfig.parse({
    id: 'wakecap',
    name: 'Wakecap',
    pathPrefixes: ['/Users/test/Wakecap'],
    ticketRegex: 'SAF-\\d+',
  }),
  forza: ProjectConfig.parse({ id: 'forza', name: 'Forza', pathPrefixes: ['/Users/test/Forza'] }),
};

function api(update = vi.fn(async (id: string) => configs[id] ?? configs.forza)) {
  return createFakeApi({
    projectsList: vi.fn(async () => projects),
    projectsGet: vi.fn(async (id: string) => {
      const c = configs[id];
      if (!c) throw new Error('missing');
      return c;
    }),
    projectsUpdate: update as never,
  });
}

describe('ProjectSettings', () => {
  it('saves only the changed fields of one project', async () => {
    const update = vi.fn(async (id: string) => configs[id] ?? configs.forza);
    renderWithProviders(<ProjectSettings />, { api: api(update) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    const save = forza.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await userEvent.clear(forza.getByLabelText('Name'));
    await userEvent.type(forza.getByLabelText('Name'), 'Forza App');
    await userEvent.click(forza.getByLabelText('Hidden'));
    await userEvent.selectOptions(forza.getByLabelText('Open in'), 'terminal');
    expect(save).toHaveProperty('disabled', false);
    await userEvent.click(save);
    expect(update).toHaveBeenCalledWith('forza', { name: 'Forza App', hidden: true, openIn: 'terminal' });
    const wakecap = within(screen.getByRole('group', { name: /wakecap/i }));
    expect(wakecap.getByLabelText('Ticket regex')).toHaveProperty('value', 'SAF-\\d+');
  });

  // Note: this is the client-side guard, not the server-error rendering path — an invalid regex
  // is rejected in the browser before any request is made. The server-error rendering path (the
  // same `role="alert"` UI, fed by an actual daemon response) is proven separately by the 422 and
  // network-failure cases below.
  it('rejects an invalid ticket regex client-side and never contacts the server', async () => {
    const update = vi.fn(async (id: string) => configs[id] ?? configs.forza);
    renderWithProviders(<ProjectSettings />, { api: api(update) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    const save = forza.getByRole('button', { name: 'Save' });
    await userEvent.type(forza.getByLabelText('Ticket regex'), '(');
    expect(await forza.findByRole('alert')).toHaveProperty(
      'textContent',
      'ticketRegex is not a valid regular expression',
    );
    expect(save).toHaveProperty('disabled', true);
    expect(forza.getByLabelText('Ticket regex')).toHaveProperty('ariaInvalid', 'true');
    await userEvent.click(save);
    expect(update).not.toHaveBeenCalled();
  });

  it('shows a 422 validation_failed error from the server without losing the typed value', async () => {
    // Matches the real daemon shape (apps/daemon/src/http/json.ts `readJson`): an unrecognised key
    // on the strict PATCH body is 422 with a message naming the offending key.
    const update = vi.fn(async () => {
      throw new ApiRequestError(
        422,
        'validation_failed',
        "invalid request: Unrecognized key(s) in object: 'nickname'",
      );
    });
    renderWithProviders(<ProjectSettings />, { api: api(update as never) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    await userEvent.clear(forza.getByLabelText('Name'));
    await userEvent.type(forza.getByLabelText('Name'), 'Forza App');
    await userEvent.click(forza.getByRole('button', { name: 'Save' }));
    expect(await forza.findByRole('alert')).toHaveProperty(
      'textContent',
      "invalid request: Unrecognized key(s) in object: 'nickname'",
    );
    // The form must not claim the never-saved value was applied: the field still shows exactly
    // what the user typed, and Save is enabled again so they can retry.
    expect(forza.getByLabelText('Name')).toHaveProperty('value', 'Forza App');
    expect(forza.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('shows a network failure legibly and lets the user retry', async () => {
    const update = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderWithProviders(<ProjectSettings />, { api: api(update as never) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    await userEvent.click(forza.getByLabelText('Hidden'));
    await userEvent.click(forza.getByRole('button', { name: 'Save' }));
    const alert = await forza.findByRole('alert');
    expect(alert.textContent).toBe('Failed to fetch');
    expect(forza.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('shows a retryable error instead of a permanent skeleton when a config fails to load', async () => {
    const getConfig = vi.fn(async (id: string) => {
      if (id === 'forza') throw new Error('network blip');
      const c = configs[id];
      if (!c) throw new Error('missing');
      return c;
    });
    renderWithProviders(<ProjectSettings />, {
      api: createFakeApi({
        projectsList: vi.fn(async () => projects),
        projectsGet: getConfig,
        projectsUpdate: vi.fn(async (id: string) => configs[id] ?? configs.forza) as never,
      }),
    });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    const alert = await forza.findByRole('alert');
    expect(alert.textContent).toContain('network blip');
    // wakecap's row is unaffected — the failure is scoped to the one project.
    const wakecap = within(screen.getByRole('group', { name: /wakecap/i }));
    expect(wakecap.getByLabelText('Ticket regex')).toHaveProperty('value', 'SAF-\\d+');

    const callsBefore = getConfig.mock.calls.length;
    await userEvent.click(forza.getByRole('button', { name: 'Retry' }));
    expect(getConfig.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('rejects a non-absolute path prefix client-side', async () => {
    const update = vi.fn(async (id: string) => configs[id] ?? configs.forza);
    renderWithProviders(<ProjectSettings />, { api: api(update) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    const save = forza.getByRole('button', { name: 'Save' });
    const paths = forza.getByLabelText('Paths');
    await userEvent.clear(paths);
    await userEvent.type(paths, 'relative/path');
    const alert = await forza.findByRole('alert');
    expect(alert.textContent).toContain('relative/path');
    expect(paths).toHaveProperty('ariaInvalid', 'true');
    expect(save).toHaveProperty('disabled', true);
    await userEvent.click(save);
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a valid absolute path prefix that contains spaces', async () => {
    const update = vi.fn(async (id: string) => configs[id] ?? configs.forza);
    renderWithProviders(<ProjectSettings />, { api: api(update) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    const save = forza.getByRole('button', { name: 'Save' });
    const paths = forza.getByLabelText('Paths');
    await userEvent.clear(paths);
    await userEvent.type(paths, '/Users/test/My Project');
    expect(forza.queryByRole('alert')).toBeNull();
    expect(save).toHaveProperty('disabled', false);
    await userEvent.click(save);
    expect(update).toHaveBeenCalledWith('forza', { pathPrefixes: ['/Users/test/My Project'] });
  });
});
