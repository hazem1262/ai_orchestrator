import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';

export type OrcApp = Hono<{ Bindings: HttpBindings }>;
