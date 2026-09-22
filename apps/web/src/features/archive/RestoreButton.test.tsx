import { ApiRequestError } from '@orc/api-contract';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { RestoreButton } from './RestoreButton.tsx';

afterEach(cleanup);

describe('RestoreButton', () => {
  it('asks for confirmation, restores and reports the result', async () => {
    const archiveRestore = vi.fn(async () => ({ restored: ['/a.jsonl', '/b.jsonl'] }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithProviders(<RestoreButton source="claude" id="s-old" />, {
      api: createFakeApi({ archiveRestore }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore transcript' }));
    expect(archiveRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore transcript' }));
    await vi.waitFor(() => expect(archiveRestore).toHaveBeenCalledWith('claude', 's-old', true));
    expect(await screen.findByText('Restored 2 file(s). The session can be resumed now.')).toBeTruthy();
    expect(confirm.mock.calls[0]?.[0]).toBe(
      'Restore the archived transcript for s-old into ~/.claude/projects? Existing files are never overwritten.',
    );
  });

  it('shows a conflict error', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithProviders(<RestoreButton source="claude" id="s-old" />, {
      api: createFakeApi({
        archiveRestore: async () => {
          throw new ApiRequestError(
            409,
            'restore_target_exists',
            'refusing to overwrite existing transcripts',
          );
        },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore transcript' }));
    expect((await screen.findByRole('alert')).textContent).toBe('refusing to overwrite existing transcripts');
  });
});
