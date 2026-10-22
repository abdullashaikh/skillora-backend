import { describe, it, expect } from 'vitest';
import { parseMarkdownQA } from '../lib/qa/parsers/markdown-parser.js';
import { parseJSONQA } from '../lib/qa/parsers/json-parser.js';
import { parseCSVQA, autoDetectColumnMapping } from '../lib/qa/parsers/csv-parser.js';
import { parseHTMLQA } from '../lib/qa/parsers/html-parser.js';
import { ContentParserService } from '../lib/qa/content-parser-service.js';

describe('QA Content Parsers', () => {
  describe('Markdown Parser', () => {
    it('should parse explicit heading convention with difficulty and code blocks', () => {
      const md = `
# JavaScript

## Closures

### Question
What is a closure in JavaScript?

### Answer
A closure is the combination of a function bundled together with references to its surrounding lexical state.
\`\`\`javascript
function outer() {
  let count = 0;
  return function() { count++; return count; };
}
\`\`\`

### Difficulty
Beginner

### Explanation
Closures allow inner functions to access outer scope variables.
`;

      const result = parseMarkdownQA(md);
      expect(result.length).toBe(1);
      expect(result[0].question).toBe('What is a closure in JavaScript?');
      expect(result[0].answer).toContain('combination of a function bundled together');
      expect(result[0].answer).toContain('```javascript');
      expect(result[0].topic).toBe('JavaScript');
      expect(result[0].subtopic).toBe('Closures');
      expect(result[0].difficulty).toBe('Beginner');
      expect(result[0].explanation).toBe('Closures allow inner functions to access outer scope variables.');
    });

    it('should parse numbered heading Q&A conventions', () => {
      const md = `
# React Interview

### 1. What are React Hooks?
Hooks are functions that let you hook into React state and lifecycle features from function components.

### 2. What is the Virtual DOM?
The Virtual DOM is a lightweight in-memory representation of the real DOM.
`;
      const result = parseMarkdownQA(md);
      expect(result.length).toBe(2);
      expect(result[0].question).toBe('What are React Hooks?');
      expect(result[0].answer).toContain('hook into React state');
      expect(result[1].question).toBe('What is the Virtual DOM?');
      expect(result[1].answer).toContain('in-memory representation');
    });

    it('should parse multiple choice options in markdown', () => {
      const md = `
### Question
Which hook is used for side effects in React?

### Options
- useState
- useEffect
- useContext
- useMemo

### Answer
useEffect is used to perform side effects in functional components.
`;
      const result = parseMarkdownQA(md);
      expect(result.length).toBe(1);
      expect(result[0].questionType).toBe('MULTIPLE_CHOICE');
      expect(result[0].options).toEqual(['useState', 'useEffect', 'useContext', 'useMemo']);
    });
  });

  describe('JSON Parser', () => {
    it('should parse valid JSON array of questions', () => {
      const jsonStr = JSON.stringify([
        {
          question: 'What is event bubbling in the browser DOM?',
          answer: 'Event bubbling is a type of event propagation where the event first triggers on the innermost target element, and then successively triggers on ancestors.',
          technology: 'JavaScript',
          topic: 'DOM',
          difficulty: 'intermediate',
        },
      ]);

      const result = parseJSONQA(jsonStr);
      expect(result.errors.length).toBe(0);
      expect(result.questions.length).toBe(1);
      expect(result.questions[0].question).toContain('event bubbling');
      expect(result.questions[0].technology).toBe('JavaScript');
    });

    it('should reject questions missing required fields and collect errors', () => {
      const invalidJson = JSON.stringify([
        { question: 'Too short', answer: '' }, // short question & empty answer
        { question: 'Valid Question Text Here?', answer: 'Valid Answer Provided' },
      ]);

      const result = parseJSONQA(invalidJson);
      expect(result.errors.length).toBe(1);
      expect(result.questions.length).toBe(1);
      expect(result.questions[0].question).toBe('Valid Question Text Here?');
    });
  });

  describe('CSV Parser', () => {
    it('should auto-detect headers and parse comma-separated rows with multiline quotes', () => {
      const csv = `Question,Answer,Technology,Topic,Difficulty
"What is a Promise in JavaScript?","A Promise is an object representing the eventual completion or failure of an asynchronous operation.
Example:
promise.then()","JavaScript","Async","Intermediate"
"What is SQL Injection?","A code injection technique that might destroy your database.","SQL","Security","Beginner"`;

      const result = parseCSVQA(csv);
      expect(result.rejectedRows.length).toBe(0);
      expect(result.questions.length).toBe(2);
      expect(result.questions[0].question).toBe('What is a Promise in JavaScript?');
      expect(result.questions[0].answer).toContain('promise.then()');
      expect(result.questions[0].technology).toBe('JavaScript');
      expect(result.questions[1].question).toBe('What is SQL Injection?');
    });
  });

  describe('HTML Parser', () => {
    it('should extract Q&A from heading patterns and strip dangerous script tags', () => {
      const html = `
      <html>
        <body>
          <main>
            <h2>What is Node.js Event Loop?</h2>
            <p>The event loop is what allows Node.js to perform non-blocking I/O operations.</p>
            <script>alert('XSS');</script>
            <pre><code class="language-js">console.log('loop');</code></pre>
            <h2>How does CSS Flexbox work?</h2>
            <p>Flexbox is a one-dimensional layout model for arranging items in rows or columns.</p>
          </main>
        </body>
      </html>
      `;

      const questions = parseHTMLQA(html);
      expect(questions.length).toBe(2);
      expect(questions[0].question).toBe('What is Node.js Event Loop?');
      expect(questions[0].answer).toContain('non-blocking I/O operations');
      expect(questions[0].answer).not.toContain('<script>');
      expect(questions[0].answer).not.toContain("alert('XSS')");
      expect(questions[0].answer).toContain('```js');
      expect(questions[1].question).toBe('How does CSS Flexbox work?');
    });

    it('should extract Q&A using explicit selectors', () => {
      const html = `
        <div class="faq-container">
          <div class="q">What is TypeScript?</div>
          <div class="a">TypeScript is a typed superset of JavaScript.</div>
        </div>
      `;

      const questions = parseHTMLQA(html, {
        questionSelector: '.q',
        answerSelector: '.a',
      });

      expect(questions.length).toBe(1);
      expect(questions[0].question).toBe('What is TypeScript?');
      expect(questions[0].answer).toBe('TypeScript is a typed superset of JavaScript.');
    });
  });

  describe('Unified ContentParserService', () => {
    it('should route by file extension and detect format', () => {
      const mdResult = ContentParserService.parse('### Question\nQ?\n### Answer\nA', { filename: 'test.md' });
      expect(mdResult.detectedFormat).toBe('MARKDOWN');
      expect(mdResult.questions.length).toBe(1);

      const jsonResult = ContentParserService.parse(JSON.stringify([{ question: 'What is Python?', answer: 'A language' }]), { filename: 'data.json' });
      expect(jsonResult.detectedFormat).toBe('JSON');
      expect(jsonResult.questions.length).toBe(1);
    });
  });
});
