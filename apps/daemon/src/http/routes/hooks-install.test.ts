import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';

describe('/api/hooks/install', () => {
  it('shows, confirms, installs and audits', async () => {
    const t = await createP3Harness();
    try {
      // The install writes Claude's settings.json: it must land in the harness's mkdtemp home.
      for (const p of [t.ctx.paths.claudeHome, t.ctx.paths.orcHome, t.ctx.paths.tokenFile]) {
        expect(p.startsWith(tmpdir())).toBe(true);
        expect(p.startsWith(join(homedir(), '.claude'))).toBe(false);
        expect(p.startsWith(join(homedir(), '.orchestrator'))).toBe(false);
      }
      const settings = join(t.ctx.paths.claudeHome, 'settings.json');
      const st = (await (await t.request('/api/hooks/install')).json()) as {
        installed: boolean;
        snippet: string;
      };
      expect(st.installed).toBe(false);
      const need = await t.request('/api/hooks/install', { method: 'POST', body: {} });
      expect(need.status).toBe(409);
      expect(await need.json()).toMatchObject({
        error: { code: 'confirmation_required', details: { summary: { settingsPath: settings } } },
      });
      expect(existsSync(settings) ? readFileSync(settings, 'utf8') : '').not.toContain('orc-hook-bridge');
      const ok = await t.request('/api/hooks/install', { method: 'POST', body: { confirm: true } });
      expect(ok.status).toBe(200);
      expect(readFileSync(settings, 'utf8')).toContain('orc-hook-bridge');
      expect(t.ctx.audit.list({ action: 'hook.install' })).toHaveLength(1);
      const sl = (await (await t.request('/api/hooks/statusline')).json()) as {
        command: string;
        snippet: string;
      };
      expect(sl.command).toMatch(/^node '.*dist\/orc-statusline\.js'$/);
      expect(JSON.parse(sl.snippet).statusLine.type).toBe('command');
    } finally {
      await t.cleanup();
    }
  });
});
