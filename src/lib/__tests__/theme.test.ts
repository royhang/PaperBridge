import { describe, expect, it } from 'vitest';
import { nextPdfTheme, resolveIsDark, resolvePdfTheme, toggleAppTheme } from '../theme';

describe('theme & PDF paper switching helpers', () => {
  it('resolves dark mode accurately for explicit and system themes', () => {
    expect(resolveIsDark('light', true)).toBe(false);
    expect(resolveIsDark('dark', false)).toBe(true);
    expect(resolveIsDark('system', false)).toBe(false);
    expect(resolveIsDark('system', true)).toBe(true);
  });

  it('always toggles directly between visible light and dark modes without dead clicks', () => {
    // Light OS with default 'system' -> first click immediately switches to dark
    expect(toggleAppTheme('system', false)).toBe('dark');
    // Dark OS with default 'system' -> first click immediately switches to light
    expect(toggleAppTheme('system', true)).toBe('light');
    // Explicit states always flip
    expect(toggleAppTheme('dark', false)).toBe('light');
    expect(toggleAppTheme('light', true)).toBe('dark');
  });

  it('cycles PDF paper theme through 3 distinct visual states with zero dead clicks in light mode', () => {
    // In light mode: auto (= original) -> dim -> dark -> auto (= original)
    expect(resolvePdfTheme('auto', false)).toBe('original');
    const step1 = nextPdfTheme('auto', false);
    expect(step1).toBe('dim');
    expect(resolvePdfTheme(step1, false)).toBe('dim');

    const step2 = nextPdfTheme(step1, false);
    expect(step2).toBe('dark');
    expect(resolvePdfTheme(step2, false)).toBe('dark');

    const step3 = nextPdfTheme(step2, false);
    expect(step3).toBe('auto');
    expect(resolvePdfTheme(step3, false)).toBe('original');
  });

  it('cycles PDF paper theme through 3 distinct visual states with zero dead clicks in dark mode', () => {
    // In dark mode: auto (= dark) -> original -> dim -> auto (= dark)
    expect(resolvePdfTheme('auto', true)).toBe('dark');
    const step1 = nextPdfTheme('auto', true);
    expect(step1).toBe('original');
    expect(resolvePdfTheme(step1, true)).toBe('original');

    const step2 = nextPdfTheme(step1, true);
    expect(step2).toBe('dim');
    expect(resolvePdfTheme(step2, true)).toBe('dim');

    const step3 = nextPdfTheme(step2, true);
    expect(step3).toBe('auto');
    expect(resolvePdfTheme(step3, true)).toBe('dark');
  });
});
