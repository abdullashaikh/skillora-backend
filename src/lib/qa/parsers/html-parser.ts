import * as cheerio from 'cheerio';
import { RawExtractedQuestion, WebsiteParserConfig } from '../types.js';

/**
 * Sanitizes an HTML element tree by removing dangerous tags and attributes to prevent XSS.
 */
function cleanDom($: cheerio.CheerioAPI, root: any) {
  root.find('script, style, iframe, object, embed, noscript, svg, form, input, button').remove();

  root.find('*').each((_: any, el: any) => {
    const attribs = el.attribs;
    if (!attribs) return;
    for (const attr of Object.keys(attribs)) {
      if (attr.startsWith('on') || attr.toLowerCase() === 'href' && attribs[attr].trim().toLowerCase().startsWith('javascript:')) {
        $(el).removeAttr(attr);
      }
    }
  });
}

/**
 * Extracts clean text with preserved code blocks and list formatting from a Cheerio element.
 */
function extractFormattedText($: cheerio.CheerioAPI, el: any): string {
  const clone = el.clone();

  // If the element itself is a <pre> block
  if (clone.is('pre')) {
    const code = clone.text().trim();
    const lang = clone.find('code').attr('class')?.match(/language-([a-z0-9]+)/i)?.[1] || '';
    return `\`\`\`${lang}\n${code}\n\`\`\``;
  }

  // If the element itself is an inline <code> tag
  if (clone.is('code')) {
    return `\`${clone.text()}\``;
  }

  // Convert descendant <pre><code> blocks into markdown fences
  clone.find('pre').each((_: any, preEl: any) => {
    const code = $(preEl).text().trim();
    const lang = $(preEl).find('code').attr('class')?.match(/language-([a-z0-9]+)/i)?.[1] || '';
    $(preEl).replaceWith(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
  });

  // Convert inline <code>
  clone.find('code').each((_: any, codeEl: any) => {
    const codeText = $(codeEl).text();
    $(codeEl).replaceWith(`\`${codeText}\``);
  });

  // Convert list items
  clone.find('li').each((_: any, liEl: any) => {
    const liText = $(liEl).text().trim();
    $(liEl).replaceWith(`\n• ${liText}`);
  });

  // Convert headings or paragraphs with newlines
  clone.find('p, div, br, h1, h2, h3, h4, h5, h6').after('\n');

  return clone.text().replace(/\n{3,}/g, '\n\n').trim();
}

export function parseHTMLQA(
  htmlContent: string,
  config: WebsiteParserConfig = {},
  defaultTopic = 'General',
  pageUrl?: string
): RawExtractedQuestion[] {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return [];
  }

  const $ = cheerio.load(htmlContent);
  cleanDom($, $.root());

  const questions: RawExtractedQuestion[] = [];
  const maxQuestions = config.maxQuestions || 100;

  // 1. Selector-based extraction if question & answer selectors provided
  if (config.questionSelector && config.answerSelector) {
    const qElements = $(config.questionSelector);
    const aElements = $(config.answerSelector);

    const count = Math.min(qElements.length, aElements.length, maxQuestions);
    for (let i = 0; i < count; i++) {
      const qText = $(qElements[i]).text().trim();
      const aText = extractFormattedText($, $(aElements[i]));

      if (qText.length >= 5 && aText.length >= 3) {
        questions.push({
          question: qText,
          answer: aText,
          topic: config.topicSelector ? $(config.topicSelector).first().text().trim() || defaultTopic : defaultTopic,
          sourceUrl: pageUrl || null,
        });
      }
    }

    if (questions.length > 0) {
      return questions;
    }
  }

  // 2. Main content container detection
  const mainScope = config.mainContentSelector
    ? $(config.mainContentSelector)
    : $('main, article, [role="main"], .content, #content, .post-content, .entry-content').first().length > 0
    ? $('main, article, [role="main"], .content, #content, .post-content, .entry-content').first()
    : $('body');

  // 3. Check for <details><summary> FAQ / Q&A pattern
  const detailsList = mainScope.find('details');
  if (detailsList.length > 0) {
    detailsList.each((_, el) => {
      if (questions.length >= maxQuestions) return;
      const summaryText = $(el).find('summary').first().text().trim();
      const clone = $(el).clone();
      clone.find('summary').remove();
      const answerText = extractFormattedText($, clone);

      if (summaryText.length >= 5 && answerText.length >= 3) {
        questions.push({
          question: summaryText,
          answer: answerText,
          topic: defaultTopic,
          sourceUrl: pageUrl || null,
        });
      }
    });

    if (questions.length > 0) {
      return questions;
    }
  }

  // 4. Check for <dl><dt><dd> FAQ / Q&A pattern
  const dtList = mainScope.find('dl dt');
  if (dtList.length > 0) {
    dtList.each((_, dtEl) => {
      if (questions.length >= maxQuestions) return;
      const qText = $(dtEl).text().trim();
      const ddEl = $(dtEl).next('dd');
      if (ddEl.length > 0) {
        const aText = extractFormattedText($, ddEl);
        if (qText.length >= 5 && aText.length >= 3) {
          questions.push({
            question: qText,
            answer: aText,
            topic: defaultTopic,
            sourceUrl: pageUrl || null,
          });
        }
      }
    });

    if (questions.length > 0) {
      return questions;
    }
  }

  // 5. Heuristic: Headings (h2, h3, h4) as Questions followed by content blocks
  const headings = mainScope.find('h2, h3, h4, h5');
  const questionWordRegex = /^(?:Q\d*[:.]|\d+[.)]|What|How|Why|Explain|Describe|When|Where|Which|Who|Define|Compare|Difference|Advantages|Disadvantages|List|Can|Is|Are|Does|Do|Could|Should)\b/i;

  headings.each((_, headingEl) => {
    if (questions.length >= maxQuestions) return;
    const hText = $(headingEl).text().trim();

    // Check if heading looks like an interview question (starts with number, question word, or ends with ?)
    const isQuestionHeading =
      (hText.endsWith('?') || questionWordRegex.test(hText)) &&
      !/^(?:Table of Contents|References|Comments|Leave a Reply|Related Articles|Recent Posts)\b/i.test(hText);

    if (isQuestionHeading && hText.length >= 5) {
      // Gather sibling elements until next heading
      const answerParts: string[] = [];
      let nextNode = $(headingEl).next();

      while (nextNode.length > 0 && !nextNode.is('h1, h2, h3, h4, h5, h6')) {
        const blockText = extractFormattedText($, nextNode);
        if (blockText) {
          answerParts.push(blockText);
        }
        nextNode = nextNode.next();
      }

      const answerContent = answerParts.join('\n\n').trim();
      if (answerContent.length >= 3) {
        questions.push({
          question: hText.replace(/^(?:Q\d*[:.]|\d+[.)])\s*/i, '').trim(),
          answer: answerContent,
          topic: defaultTopic,
          sourceUrl: pageUrl || null,
        });
      }
    }
  });

  if (questions.length > 0) {
    return questions;
  }

  // 6. Heuristic: Paragraph with leading strong / bold question
  // e.g. <p><strong>1. What is React?</strong></p> or <p><b>Q: What is JSX?</b></p>
  const strongParagraphs = mainScope.find('p strong, p b');
  strongParagraphs.each((_, boldEl) => {
    if (questions.length >= maxQuestions) return;
    const bText = $(boldEl).text().trim();
    const parentP = $(boldEl).closest('p');

    const isQ =
      (bText.endsWith('?') || questionWordRegex.test(bText)) &&
      bText.length >= 5 &&
      !/^(?:Note|Warning|Tip|Important|Disclaimer):/i.test(bText);

    if (isQ) {
      const answerParts: string[] = [];
      // Any text after the bold inside the same <p>
      const cloneP = parentP.clone();
      cloneP.find(boldEl).remove();
      const inlineRest = cloneP.text().trim();
      if (inlineRest.length > 5) {
        answerParts.push(inlineRest);
      }

      // Sibling paragraphs following parentP
      let nextNode = parentP.next();
      while (nextNode.length > 0 && !nextNode.is('h1, h2, h3, h4, h5, h6') && nextNode.find('strong, b').first().text().trim().length < 5) {
        const text = extractFormattedText($, nextNode);
        if (text) answerParts.push(text);
        nextNode = nextNode.next();
      }

      const fullAnswer = answerParts.join('\n\n').trim();
      if (fullAnswer.length >= 5) {
        questions.push({
          question: bText.replace(/^(?:Q\d*[:.]|\d+[.)])\s*/i, '').trim(),
          answer: fullAnswer,
          topic: defaultTopic,
          sourceUrl: pageUrl || null,
        });
      }
    }
  });

  return questions;
}
