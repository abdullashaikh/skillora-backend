import { describe, it, expect } from 'vitest';
import { cleanStringForMatching } from '../lib/scoring/skill-normalizer';

describe('Skill Normalization Rules', () => {
  it('should clean and normalize special characters correctly without collision', () => {
    expect(cleanStringForMatching('C++')).toBe('cplusplus');
    expect(cleanStringForMatching('C#')).toBe('csharp');
    expect(cleanStringForMatching('.NET Core')).toBe('dotnetcore');
    expect(cleanStringForMatching('Node.js')).toBe('nodejs');
    expect(cleanStringForMatching('React.js')).toBe('reactjs');
  });

  it('should treat case and whitespace consistently', () => {
    expect(cleanStringForMatching(' JavaScript ')).toBe('javascript');
    expect(cleanStringForMatching('TypeScript')).toBe('typescript');
  });
});
