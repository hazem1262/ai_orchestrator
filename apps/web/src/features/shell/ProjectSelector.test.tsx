import type { Project } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/project.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ProjectSelector } from './ProjectSelector.tsx';

const projects: Project[] = [
  {
    id: 'wakecap',
    name: 'Wakecap',
    pathPrefixes: ['/w'],
    hidden: false,
    lastActivityAt: '2026-09-06',
    sessionCount: 3,
  },
  {
    id: 'forza',
    name: 'Forza',
    pathPrefixes: ['/f'],
    hidden: false,
    lastActivityAt: '2026-09-04',
    sessionCount: 1,
  },
  { id: 'old', name: 'Old', pathPrefixes: ['/o'], hidden: true, lastActivityAt: null, sessionCount: 0 },
];

describe('ProjectSelector', () => {
  beforeEach(() => useProjectStore.setState({ projectId: 'wakecap' }));

  it('lists visible projects plus All projects and stores the choice', async () => {
    const api = createFakeApi({ projectsList: vi.fn(async () => projects) });
    renderWithProviders(<ProjectSelector />, { api });
    const select = await screen.findByRole('combobox', { name: 'Project' });
    await screen.findByRole('option', { name: 'Forza (1)' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Wakecap (3)',
      'Forza (1)',
      'All projects',
    ]);
    await userEvent.selectOptions(select, 'forza');
    expect(useProjectStore.getState().projectId).toBe('forza');
    expect(JSON.parse(localStorage.getItem('orc.project') ?? '{}')).toMatchObject({
      state: { projectId: 'forza' },
    });
    await userEvent.selectOptions(select, 'all');
    expect(useProjectStore.getState().projectId).toBe('all');
  });

  it('falls back to the default project when the stored one is gone', async () => {
    useProjectStore.setState({ projectId: 'deleted' });
    renderWithProviders(<ProjectSelector />, {
      api: createFakeApi({ projectsList: vi.fn(async () => projects) }),
    });
    await waitFor(() => expect(useProjectStore.getState().projectId).toBe('wakecap'));
  });
});
