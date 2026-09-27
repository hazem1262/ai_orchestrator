import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import type { RemoteInfo } from './p6-util.ts';

export type OrcEnv = { Bindings: HttpBindings; Variables: { remote: RemoteInfo | null } };
export type OrcApp = Hono<OrcEnv>;
