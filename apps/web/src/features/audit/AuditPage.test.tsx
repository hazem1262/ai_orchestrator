import type { AuditEntry } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudit } from '@/api/queries/audit';
import { useProjectStore } from '@/stores/project';
import { renderP3 } from '@/test/p3-render';
import { AuditPage, isoToLocalDay, localDayToIso } from './AuditPage.tsx';

vi.mock('@/api/queries/audit', () => ({ useAudit: vi.fn() }));

const entries: AuditEntry[] = [
  {
    id: 'e1',
    ts: '2026-09-17T10:00:02.000Z',
    actor: 'user',
    actorDetail: 'Mozilla',
    action: 'pty.input',
    target: 'claude:s-basic',
    params: { via: 'keys', text: 'PGPASSWORD=«redacted:secret»' },
    result: 'ok',
    error: null,
  },
  {
    id: 'e2',
    ts: '2026-09-17T10:00:01.000Z',
    actor: 'automation',
    actorDetail: null,
    action: 'session.kill',
    target: 'pty:abc',
    params: { status: 403 },
    result: 'denied',
    error: 'not_owned: session is not owned',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAudit).mockReturnValue({ data: entries, isLoading: false, isError: false } as never);
  useProjectStore.setState({ projectId: 'wakecap' });
});

describe('AuditPage', () => {
  it('lists entries with session links and expandable redacted params', async () => {
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    expect(vi.mocked(useAudit)).toHaveBeenCalledWith({ limit: 500 });
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'claude:s-basic' }).getAttribute('href')).toBe(
      '/sessions/claude/s-basic',
    );
    expect(screen.getByText('pty:abc')).toBeDefined();
    expect(screen.getByText('denied')).toBeDefined();
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[0] as HTMLElement);
    expect(screen.getByTestId('audit-params-e1').textContent).toContain('«redacted:secret»');
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[1] as HTMLElement);
    expect(screen.getByTestId('audit-error-e2').textContent).toBe('not_owned: session is not owned');
  });

  it('pushes filter changes into the search', async () => {
    const onSearch = vi.fn();
    renderP3(<AuditPage search={{ q: 'x' }} onSearch={onSearch} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Actor' }), 'automation');
    expect(onSearch).toHaveBeenLastCalledWith({ q: 'x', actor: 'automation' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Current project only' }));
    expect(onSearch).toHaveBeenLastCalledWith({ q: 'x', projectId: 'wakecap' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onSearch).toHaveBeenLastCalledWith({});
  });

  it('has a visible label for every filter field', () => {
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    for (const name of ['Search', 'Actor', 'Action', 'Session', 'From', 'To', 'Current project only']) {
      expect(screen.getByLabelText(name)).toBeDefined();
    }
  });

  it('pushes the search, action and session text filters', async () => {
    const onSearch = vi.fn();
    renderP3(<AuditPage search={{}} onSearch={onSearch} />);
    await userEvent.type(screen.getByLabelText('Search'), 'x');
    expect(onSearch).toHaveBeenLastCalledWith({ q: 'x' });
    await userEvent.type(screen.getByLabelText('Action'), 's');
    expect(onSearch).toHaveBeenLastCalledWith({ action: 's' });
    await userEvent.type(screen.getByLabelText('Session'), 'c');
    expect(onSearch).toHaveBeenLastCalledWith({ sessionPk: 'c' });
  });

  it('pushes from/to dates as day-boundary ISO timestamps', async () => {
    const onSearch = vi.fn();
    renderP3(<AuditPage search={{}} onSearch={onSearch} />);
    await userEvent.type(screen.getByLabelText('From'), '2026-09-17');
    expect(onSearch).toHaveBeenLastCalledWith({ from: localDayToIso('2026-09-17', 'start') });
    await userEvent.type(screen.getByLabelText('To'), '2026-09-18');
    expect(onSearch).toHaveBeenLastCalledWith({ to: localDayToIso('2026-09-18', 'end') });
  });

  it('shows a match count next to Clear filters', () => {
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    expect(screen.getByText('2 entries')).toBeDefined();
  });

  it('shows an empty state', () => {
    vi.mocked(useAudit).mockReturnValue({ data: [], isLoading: false, isError: false } as never);
    renderP3(<AuditPage search={{ sessionPk: 'claude:x' }} onSearch={vi.fn()} />);
    expect(screen.getByText('No audit entries match these filters.')).toBeDefined();
  });

  it('shows a loading skeleton', () => {
    vi.mocked(useAudit).mockReturnValue({ data: undefined, isLoading: true, isError: false } as never);
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    expect(screen.getByLabelText('Loading audit log')).toBeDefined();
  });

  it('shows an alert when the query fails', () => {
    vi.mocked(useAudit).mockReturnValue({ data: undefined, isLoading: false, isError: true } as never);
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load the audit log');
  });
});

describe('AuditPage on a phone', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
  });

  it('renders cards instead of a table, and expands a row to show redacted params', async () => {
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('pty.input')).toBeDefined();
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[0] as HTMLElement);
    expect(screen.getByTestId('audit-params-e1').textContent).toContain('«redacted:secret»');
  });
});

describe('day conversion', () => {
  it('round-trips local days', () => {
    const start = localDayToIso('2026-09-17', 'start');
    const end = localDayToIso('2026-09-17', 'end');
    expect(Date.parse(end) - Date.parse(start)).toBe(24 * 3600 * 1000 - 1);
    expect(isoToLocalDay(start)).toBe('2026-09-17');
  });
});
