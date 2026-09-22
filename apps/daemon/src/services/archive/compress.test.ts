import { describe, expect, it } from 'vitest';
import { availableCodec, codecExtension, compressBuffer, decompressBuffer } from './compress.ts';

describe('compress', () => {
  it('detects zstd support', () => {
    expect(availableCodec({})).toBe('gzip');
    expect(availableCodec({ zstdCompress: () => undefined })).toBe('gzip');
    expect(availableCodec({ zstdCompress: 1, zstdDecompress: 1 })).toBe('gzip');
    expect(availableCodec({ zstdCompress: () => undefined, zstdDecompress: () => undefined })).toBe('zstd');
    expect(['zstd', 'gzip']).toContain(availableCodec());
  });

  it('maps codecs to extensions', () => {
    expect(codecExtension('zstd')).toBe('.zst');
    expect(codecExtension('gzip')).toBe('.gz');
  });

  it.each(['gzip', availableCodec()] as const)('round-trips with %s', async (codec) => {
    const input = Buffer.from('{"type":"user"}\n'.repeat(500));
    const packed = await compressBuffer(input, codec);
    expect(packed.length).toBeLessThan(input.length / 5);
    expect((await decompressBuffer(packed, codec)).equals(input)).toBe(true);
  });

  it('round-trips an empty buffer', async () => {
    const packed = await compressBuffer(Buffer.alloc(0), 'gzip');
    expect((await decompressBuffer(packed, 'gzip')).length).toBe(0);
  });
});
