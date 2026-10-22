import { RawExtractedQuestion } from '../types.js';

/**
 * Parses Markdown documents containing technical interview questions and answers.
 * Supports:
 * 1. Explicit convention:
 *    ### Question: ...
 *    ### Answer: ...
 *    ### Difficulty: ...
 *    ### Explanation: ...
 * 2. Numbered prefix before heading:
 *    1. ### What is React?
 * 3. Topic/Section hierarchical convention:
 *    # Topic
 *    ## Subtopic
 *    ### 1. What is X?
 *    Paragraphs / Code blocks as Answer
 * 4. Question headings:
 *    ### What is React?
 *    ### Explain event delegation
 * 5. Q: / A: inline convention
 */
export function parseMarkdownQA(markdownContent: string, defaultTopic = 'General'): RawExtractedQuestion[] {
  if (!markdownContent || typeof markdownContent !== 'string') {
    return [];
  }

  const results: RawExtractedQuestion[] = [];
  const lines = markdownContent.replace(/\r\n/g, '\n').split('\n');

  let currentTopic = defaultTopic;
  let currentSubtopic: string | null = null;
  let documentTopic: string | null = null;

  // Track state for multi-heading explicit format
  let pendingQuestion: Partial<RawExtractedQuestion> | null = null;
  let activeSection: 'QUESTION' | 'ANSWER' | 'EXPLANATION' | 'DIFFICULTY' | 'OPTIONS' | null = null;
  let sectionContentBuffer: string[] = [];

  const cleanAnswerText = (text: string): string => {
    return text
      .replace(/\*\*\[(?:[⬆▲]\s*)?Back to Top\b.*?\]\(.*?\)\*\*/gi, '')
      .replace(/\[(?:[⬆▲]\s*)?Back to Top\b.*?\]\(.*?\)/gi, '')
      .replace(/^[*-]{3,}$/gm, '')
      .replace(/<details open>[\s\S]*?<\/details>/gi, (match) => {
        // If it's a deep-dive answer detail, convert to normal text instead of dropping
        return match.replace(/<\/?details[^>]*>|<\/?summary[^>]*>/gi, '');
      })
      .trim();
  };

  const flushSection = () => {
    if (!pendingQuestion || !activeSection) return;
    const text = sectionContentBuffer.join('\n').trim();
    if (!text) return;

    if (activeSection === 'QUESTION') {
      pendingQuestion.question = pendingQuestion.question ? `${pendingQuestion.question}\n${text}` : text;
    } else if (activeSection === 'ANSWER') {
      pendingQuestion.answer = pendingQuestion.answer ? `${pendingQuestion.answer}\n${text}` : text;
    } else if (activeSection === 'EXPLANATION') {
      pendingQuestion.explanation = pendingQuestion.explanation ? `${pendingQuestion.explanation}\n${text}` : text;
    } else if (activeSection === 'DIFFICULTY') {
      pendingQuestion.difficulty = text;
    } else if (activeSection === 'OPTIONS') {
      const parsedOptions = text
        .split('\n')
        .map((l) => l.replace(/^[-*•]\s*|\([a-zA-Z0-9]\)\s*|[A-Da-d]\.\s*/, '').trim())
        .filter(Boolean);
      pendingQuestion.options = parsedOptions;
      if (parsedOptions.length > 0) {
        pendingQuestion.questionType = 'MULTIPLE_CHOICE';
      }
    }

    sectionContentBuffer = [];
  };

  const flushQuestion = () => {
    flushSection();
    if (pendingQuestion && pendingQuestion.question) {
      const cleanedQuestion = pendingQuestion.question
        .trim()
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^#{1,5}\s*/, '')
        .trim();
      const cleanedAnswer = cleanAnswerText(pendingQuestion.answer || '');

      const isCodeOutput =
        /what (?:is|will be) the output|predict the output|output of the following/i.test(cleanedQuestion) ||
        (cleanedQuestion.includes('```') && /output/i.test(cleanedQuestion));

      const finalQuestionType = isCodeOutput
        ? 'CODE_OUTPUT'
        : pendingQuestion.questionType || (pendingQuestion.options && pendingQuestion.options.length > 0 ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER');

      if (cleanedAnswer.length >= 1 && cleanedQuestion.length >= 1) {
        results.push({
          question: cleanedQuestion,
          answer: cleanedAnswer,
          explanation: pendingQuestion.explanation?.trim() || null,
          topic: pendingQuestion.topic || currentTopic,
          subtopic: pendingQuestion.subtopic || currentSubtopic,
          difficulty: pendingQuestion.difficulty || 'UNKNOWN',
          questionType: finalQuestionType,
          options: pendingQuestion.options || null,
          correctOption: pendingQuestion.correctOption || null,
        });
      }
    }
    pendingQuestion = null;
    activeSection = null;
    sectionContentBuffer = [];
  };

  let inCodeBlock = false;
  let inTableOfContents = false;
  const questionWordRegex = /^(?:What|How|Why|Explain|Describe|When|Where|Can|Difference between|Compare|Define|Which|Is|Does|List|Advantages of|Disadvantages of|Predict|Write|Give)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Table rows are never questions
    if (trimmed.startsWith('|')) {
      if (activeSection) sectionContentBuffer.push(rawLine);
      continue;
    }

    // Skip Table of Contents block
    if (/^#{1,4}\s+Table of Contents/i.test(trimmed)) {
      inTableOfContents = true;
      continue;
    }

    if (inTableOfContents) {
      // Exit TOC when we encounter a content heading that is not Table of Contents
      if (/^#{1,3}\s+/.test(trimmed) && !/Table of Contents/i.test(trimmed)) {
        inTableOfContents = false;
      } else {
        continue;
      }
    }

    // Check for explicit labeled headings (e.g. ### Question, ### Answer, etc.)
    const explicitHeadingMatch = trimmed.match(/^#{2,5}\s+(Question|Answer|Explanation|Difficulty|Options|Option)\b[:\s]*(.*)/i);
    if (explicitHeadingMatch) {
      inCodeBlock = false;
      const headingType = explicitHeadingMatch[1].toUpperCase();
      const inlineRest = explicitHeadingMatch[2].trim();

      if (headingType === 'QUESTION') {
        flushQuestion();
        pendingQuestion = {
          topic: currentTopic,
          subtopic: currentSubtopic,
        };
        activeSection = 'QUESTION';
        if (inlineRest) sectionContentBuffer.push(inlineRest);
      } else if (headingType === 'ANSWER') {
        flushSection();
        activeSection = 'ANSWER';
        if (inlineRest) sectionContentBuffer.push(inlineRest);
      } else if (headingType === 'EXPLANATION') {
        flushSection();
        activeSection = 'EXPLANATION';
        if (inlineRest) sectionContentBuffer.push(inlineRest);
      } else if (headingType === 'DIFFICULTY') {
        flushSection();
        activeSection = 'DIFFICULTY';
        if (inlineRest) sectionContentBuffer.push(inlineRest);
      } else if (headingType.startsWith('OPTION')) {
        flushSection();
        activeSection = 'OPTIONS';
        if (inlineRest) sectionContentBuffer.push(inlineRest);
      }
      continue;
    }

    // Pattern A: Numbered prefix before heading: 1.  ### What is React? or 1. ### Question
    const numBeforeHeadingMatch = trimmed.match(/^\d+[.)]\s+#{1,5}\s+(.+)/);
    if (numBeforeHeadingMatch) {
      inCodeBlock = false;
      flushQuestion();
      pendingQuestion = {
        question: numBeforeHeadingMatch[1].trim(),
        topic: currentTopic,
        subtopic: currentSubtopic,
      };
      activeSection = 'ANSWER';
      continue;
    }

    // Pattern B: Numbered question heading convention: ### 1. Question text? or ### Q1: Question text?
    const numberedHeadingMatch = trimmed.match(/^#{2,5}\s+(?:Q\d+[:.]|\d+[.)])\s+(.+)/i);
    if (numberedHeadingMatch) {
      inCodeBlock = false;
      flushQuestion();
      pendingQuestion = {
        question: numberedHeadingMatch[1].trim(),
        topic: currentTopic,
        subtopic: currentSubtopic,
      };
      activeSection = 'ANSWER';
      continue;
    }

    // Pattern C: Question heading: ### What is React? or ### Explain event delegation
    const questionHeadingMatch = !trimmed.startsWith('# ') && trimmed.match(/^#{2,5}\s+(.+)/);
    if (questionHeadingMatch) {
      const title = questionHeadingMatch[1].trim();
      const isMetaHeading = /^(?:Table of Contents|References|Further Reading|See Also|License|Contributing|Contributors|Summary|Note|Notes|Disclaimer)\b/i.test(title);
      const isQuestion = !isMetaHeading && (title.endsWith('?') || questionWordRegex.test(title));

      if (isQuestion) {
        inCodeBlock = false;
        flushQuestion();
        pendingQuestion = {
          question: title,
          topic: currentTopic,
          subtopic: currentSubtopic,
        };
        activeSection = 'ANSWER';
        continue;
      }
    }

    // Pattern D: "Q:" / "Question:" start of paragraph
    const inlineQMatch = trimmed.match(/^(?:\*\*|\*|)(?:Q\d*|Question)\s*[:.-]\s*(?:\*\*|\*|)\s*(.+)/i);
    if (inlineQMatch) {
      inCodeBlock = false;
      flushQuestion();
      pendingQuestion = {
        question: inlineQMatch[1].trim(),
        topic: currentTopic,
        subtopic: currentSubtopic,
      };
      activeSection = 'ANSWER';
      continue;
    }

    // Pattern E: "A:" / "Answer:" start of paragraph
    const inlineAMatch = trimmed.match(/^(?:\*\*|\*|)(?:A\d*|Answer)\s*[:.-]\s*(?:\*\*|\*|)\s*(.*)/i);
    if (inlineAMatch && pendingQuestion) {
      flushSection();
      activeSection = 'ANSWER';
      if (inlineAMatch[1].trim()) {
        sectionContentBuffer.push(inlineAMatch[1].trim());
      }
      continue;
    }

    // Code block fences
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (activeSection) {
        sectionContentBuffer.push(rawLine.replace(/^\s{4}/, ''));
      }
      continue;
    }

    if (inCodeBlock) {
      if (activeSection) {
        sectionContentBuffer.push(rawLine.replace(/^\s{4}/, ''));
      }
      continue;
    }

    // Top-level document or topic headings (# Topic, ## Subtopic)
    if (/^#\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#\s+/, '').trim();
      const isDocumentTitle = /interview|questions|handbook|guide|cheatsheet|quiz/i.test(heading);
      if (isDocumentTitle) {
        documentTopic = null;
      } else {
        documentTopic = heading;
        currentTopic = heading;
      }
      currentSubtopic = null;
      continue;
    }

    if (/^##\s+/.test(trimmed)) {
      const headingText = trimmed.replace(/^##\s+/, '').trim();
      if (documentTopic) {
        currentSubtopic = headingText;
      } else {
        currentTopic = headingText;
        currentSubtopic = null;
      }
      continue;
    }

    if (/^###\s+/.test(trimmed)) {
      currentSubtopic = trimmed.replace(/^###\s+/, '').trim();
      continue;
    }

    // Regular line in current active section
    if (activeSection) {
      // Strip markdown list indentation if it was an indented answer block under 1. ###
      const unindented = rawLine.replace(/^\s{4}/, '');
      sectionContentBuffer.push(unindented);
    }
  }

  flushQuestion();

  return results;
}
