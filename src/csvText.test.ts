import { describe, expect, it } from 'vitest';
import { decodeCsvBytes } from './csvText';

describe('decodeCsvBytes', () => {
  it('decodes UTF-8 with BOM (our own export format)', () => {
    const body = new TextEncoder().encode('名稱,日期,量測深度\n');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(decodeCsvBytes(bytes)).toBe('名稱,日期,量測深度\n');
  });

  it('falls back to Big5 for Excel zh-TW (cp950) CSV', () => {
    // "名稱,日期,量測深度" encoded as cp950
    const bytes = new Uint8Array([
      0xa6, 0x57, 0xba, 0xd9, 0x2c, 0xa4, 0xe9, 0xb4, 0xc1, 0x2c,
      0xb6, 0x71, 0xb4, 0xfa, 0xb2, 0x60, 0xab, 0xd7,
    ]);
    expect(decodeCsvBytes(bytes)).toBe('名稱,日期,量測深度');
  });
});
