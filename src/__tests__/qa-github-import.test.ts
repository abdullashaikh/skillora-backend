import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubSourceAdapter } from '../lib/qa/github-source-adapter.js';
import { parseMarkdownQA } from '../lib/qa/parsers/markdown-parser.js';
import { calculateTokenSimilarity, DuplicateDetectionService } from '../lib/qa/duplicate-detection-service.js';
import { validateSafeUrl } from '../lib/qa/url-validator.js';

describe('GitHub Import Pipeline & Markdown Parser Test Suite', () => {
  describe('1. GitHub URL Parser', () => {
    it('should parse standard repository root URL', () => {
      const parsed = GitHubSourceAdapter.parseGitHubUrl('https://github.com/sudheerj/reactjs-interview-questions');
      expect(parsed.isSingleFile).toBe(false);
      expect(parsed.owner).toBe('sudheerj');
      expect(parsed.repo).toBe('reactjs-interview-questions');
      expect(parsed.branch).toBe('main');
    });

    it('should parse tree URL with branch and subdirectory', () => {
      const parsed = GitHubSourceAdapter.parseGitHubUrl('https://github.com/sudheerj/reactjs-interview-questions/tree/master/coding-exercise');
      expect(parsed.isSingleFile).toBe(false);
      expect(parsed.owner).toBe('sudheerj');
      expect(parsed.repo).toBe('reactjs-interview-questions');
      expect(parsed.branch).toBe('master');
      expect(parsed.path).toBe('coding-exercise');
    });

    it('should parse blob single file URL', () => {
      const parsed = GitHubSourceAdapter.parseGitHubUrl('https://github.com/sudheerj/reactjs-interview-questions/blob/master/README.md');
      expect(parsed.isSingleFile).toBe(true);
      expect(parsed.owner).toBe('sudheerj');
      expect(parsed.repo).toBe('reactjs-interview-questions');
      expect(parsed.branch).toBe('master');
      expect(parsed.path).toBe('README.md');
      expect(parsed.rawUrl).toBe('https://raw.githubusercontent.com/sudheerj/reactjs-interview-questions/master/README.md');
    });

    it('should parse raw.githubusercontent.com URL', () => {
      const parsed = GitHubSourceAdapter.parseGitHubUrl('https://raw.githubusercontent.com/sudheerj/reactjs-interview-questions/master/README.md');
      expect(parsed.isSingleFile).toBe(true);
      expect(parsed.owner).toBe('sudheerj');
      expect(parsed.repo).toBe('reactjs-interview-questions');
      expect(parsed.branch).toBe('master');
      expect(parsed.path).toBe('README.md');
    });

    it('should reject invalid GitHub hosts', () => {
      expect(() => GitHubSourceAdapter.parseGitHubUrl('https://malicious-site.com/sudheerj/reactjs-interview-questions')).toThrow(
        /not a recognized GitHub host/i
      );
    });
  });

  describe('2. Markdown Parser on Real-World React Fixture', () => {
    const fixtureMarkdown = `
# React Interview Questions & Answers

### Table of Contents

| No. | Questions |
| --- | --------- |
| 1   | [What is React?](#what-is-react) |
| 2   | [What is JSX?](#what-is-jsx) |
| 3   | [What will be the output of following code?](#predict-output) |

## Core React

1.  ### What is React?

    React (aka React.js or ReactJS) is an **open-source front-end JavaScript library** for building user interfaces based on components.

    It was created by Jordan Walke.

    <details>
        <summary><b>See deep-dive answer</b></summary>
        The evolution of React began at Facebook in 2011.
    </details>

    **[⬆ Back to Top](#table-of-contents)**

2.  ### What is JSX?

    JSX stands for *JavaScript XML*. It allows us to write HTML elements in JavaScript and place them in the DOM.

    \`\`\`jsx
    const element = <h1>Hello, world!</h1>;
    \`\`\`

    ***

3.  ### What will be the output of following code?

    Consider the code snippet below:

    \`\`\`javascript
    console.log(typeof NaN);
    \`\`\`

    The output will be \`number\` because in JavaScript, NaN is a numeric type value.

    [Back to Top](#table-of-contents)
`;

    it('should ignore Table of Contents and not parse links as questions', () => {
      const parsed = parseMarkdownQA(fixtureMarkdown);
      const tocItems = parsed.filter((q) => q.question.includes('Table of Contents') || q.question.startsWith('|'));
      expect(tocItems.length).toBe(0);
    });

    it('should parse numbered heading variant "1.  ### What is React?" with proper topic and preserved body', () => {
      const parsed = parseMarkdownQA(fixtureMarkdown);
      expect(parsed.length).toBe(3);

      const q1 = parsed[0];
      expect(q1.question).toBe('What is React?');
      expect(q1.topic).toBe('Core React');
      expect(q1.answer).toContain('open-source front-end JavaScript library');
      expect(q1.answer).toContain('Jordan Walke');
      expect(q1.answer).toContain('evolution of React began');
      // Should strip Back to Top
      expect(q1.answer).not.toContain('Back to Top');
    });

    it('should preserve code fences exactly in JSX question', () => {
      const parsed = parseMarkdownQA(fixtureMarkdown);
      const q2 = parsed[1];
      expect(q2.question).toBe('What is JSX?');
      expect(q2.answer).toContain('```jsx\nconst element = <h1>Hello, world!</h1>;\n```');
      expect(q2.answer).not.toContain('***');
    });

    it('should detect CODE_OUTPUT question type', () => {
      const parsed = parseMarkdownQA(fixtureMarkdown);
      const q3 = parsed[2];
      expect(q3.question).toBe('What will be the output of following code?');
      expect(q3.questionType).toBe('CODE_OUTPUT');
      expect(q3.answer).toContain('typeof NaN');
    });
  });

  describe('3. Duplicate Detection & Dice Similarity', () => {
    it('should return 1.0 for identical token sets', () => {
      const textA = 'What is the Virtual DOM in React?';
      const textB = 'What is the Virtual DOM in React?';
      expect(calculateTokenSimilarity(textA, textB)).toBe(1.0);
    });

    it('should identify high similarity > 0.85 for slight phrasing differences', () => {
      const textA = 'How does Virtual DOM work in React applications?';
      const textB = 'How does the Virtual DOM work in React applications?';
      const score = calculateTokenSimilarity(textA, textB);
      expect(score).toBeGreaterThan(0.85);
    });

    it('should return lower score for distinct questions', () => {
      const textA = 'What are React Hooks and how do they work?';
      const textB = 'How does Redux state management integrate with React?';
      const score = calculateTokenSimilarity(textA, textB);
      expect(score).toBeLessThan(0.5);
    });
  });

  describe('4. SSRF Validation for GitHub Hosts', () => {
    it('should allow public GitHub API host', async () => {
      const res = await validateSafeUrl('https://api.github.com/repos/sudheerj/reactjs-interview-questions');
      expect(res.isValid).toBe(true);
    });

    it('should allow public raw.githubusercontent.com host', async () => {
      const res = await validateSafeUrl('https://raw.githubusercontent.com/sudheerj/reactjs-interview-questions/master/README.md');
      expect(res.isValid).toBe(true);
    });

    it('should block localhost and private network endpoints', async () => {
      const local = await validateSafeUrl('http://127.0.0.1:5000/internal');
      expect(local.isValid).toBe(false);
      expect(local.error).toMatch(/private|reserved|loopback|blocked/i);

      const metadata = await validateSafeUrl('http://169.254.169.254/latest/meta-data');
      expect(metadata.isValid).toBe(false);
    });
  });
});
