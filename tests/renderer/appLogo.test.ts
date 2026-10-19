import { describe, expect, it } from 'vitest';
import { logoFor } from '../../src/renderer/src/components/AppLogo';

describe('AppLogo frame choice', () => {
  it('uses the exact frame for each Windows scale', () => {
    const name = (r: number) => logoFor(r);
    expect(new Set([1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(name)).size).toBe(7); // seven different files
    expect(name(1.5)).not.toBe(name(2)); // 24 px at 150%, not the 32 px one
    expect(name(1)).not.toBe(name(1.25));
  });
  it('uses the biggest frame above 3x', () => {
    expect(logoFor(4)).toBe(logoFor(3));
  });
});
