import { describe, it, expect } from 'vitest';
import { calculateTokenSimilarity, computeDifferenceSummary } from '../lib/qa/duplicate-detection-service.js';
import { computeDeterministicContentHash } from '../lib/qa/content-normalization-service.js';

describe('Deduplication & Content Matching', () => {
  it('should generate identical content hashes for questions with different casing and whitespace', () => {
    const textA = 'What is a   closure in JavaScript?';
    const textB = '  WHAT IS A CLOSURE IN JAVASCRIPT?  \n';

    const hashA = computeDeterministicContentHash(textA);
    const hashB = computeDeterministicContentHash(textB);

    expect(hashA).toBe(hashB);
  });

  it('should generate different content hashes for distinct questions', () => {
    const hashA = computeDeterministicContentHash('What is a closure in JavaScript?');
    const hashB = computeDeterministicContentHash('What is hoisting in JavaScript?');

    expect(hashA).not.toBe(hashB);
  });

  it('should detect high token similarity for paraphrased questions', () => {
    const q1 = 'Explain how the virtual DOM works in React and its benefits';
    const q2 = 'How does the virtual DOM work in React, and what are the advantages?';

    const similarity = calculateTokenSimilarity(q1, q2);
    expect(similarity).toBeGreaterThan(0.7);

    const diff = computeDifferenceSummary(q1, q2);
    expect(diff).toBeTruthy();
  });

  it('should report low similarity for completely different questions', () => {
    const q1 = 'What is an index in a relational database?';
    const q2 = 'How do CSS grid layouts work?';

    const similarity = calculateTokenSimilarity(q1, q2);
    expect(similarity).toBeLessThan(0.2);
  });
});
