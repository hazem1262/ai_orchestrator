import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

export type ArchiveCodec = 'zstd' | 'gzip';

type Cb = (err: Error | null, out: Buffer) => void;
export interface ZstdApi {
  zstdCompress?: unknown;
  zstdDecompress?: unknown;
}
interface ZstdFns {
  zstdCompress: (buf: Buffer, cb: Cb) => void;
  zstdDecompress: (buf: Buffer, cb: Cb) => void;
}

const zlibAny = zlib as unknown as ZstdApi;

/** zstd ships in node:zlib from Node 22.15 (experimental). The feature is detected at runtime, and gzip is the fallback. */
export function availableCodec(z: ZstdApi = zlibAny): ArchiveCodec {
  return typeof z.zstdCompress === 'function' && typeof z.zstdDecompress === 'function' ? 'zstd' : 'gzip';
}

export function codecExtension(c: ArchiveCodec): '.zst' | '.gz' {
  return c === 'zstd' ? '.zst' : '.gz';
}

function zstd(): ZstdFns {
  if (availableCodec() !== 'zstd') throw new Error('zstd is not available in this Node build');
  return zlibAny as unknown as ZstdFns;
}

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function compressBuffer(buf: Buffer, codec: ArchiveCodec): Promise<Buffer> {
  if (codec === 'gzip') return gzip(buf, { level: 6 });
  const z = zstd();
  return new Promise((resolve, reject) =>
    z.zstdCompress(buf, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

export function decompressBuffer(buf: Buffer, codec: ArchiveCodec): Promise<Buffer> {
  if (codec === 'gzip') return gunzip(buf);
  const z = zstd();
  return new Promise((resolve, reject) =>
    z.zstdDecompress(buf, (err, out) => (err ? reject(err) : resolve(out))),
  );
}
