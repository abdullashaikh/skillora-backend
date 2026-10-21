/**
 * Scrub unnecessary personal contact details from resume text before external AI processing.
 * Retains job titles, employment dates, skills, educational institutions, projects, and achievements.
 */

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;

// Comprehensive international & domestic phone regex
const PHONE_REGEX = /(?:(?:\+?1\s*(?:[.-]\s*)?)?(?:\(\s*([2-9]1[02-9]|[2-9][02-8]1|[2-9][02-8][02-9])\s*\)|([2-9]1[02-9]|[2-9][02-8]1|[2-9][02-8][02-9]))\s*(?:[.-]\s*)?)?([2-9]1[02-9]|[2-9][02-9]1|[2-9][02-9]{2})\s*(?:[.-]\s*)?([0-9]{4})(?:\s*(?:#|x\.?|ext\.?|extension)\s*(\d+))?|\b\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g;

// Address patterns: Street, Avenue, Boulevard, Drive, Rd, Lane, P.O. Box, Apt, Suite, Zip codes
const ADDRESS_REGEX = /\b\d{1,5}\s+[A-Za-z0-9.,\s]{3,35}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Square|Sq|Trail|Trl|Pkwy|Parkway|Highway|Hwy|Suite|Ste|Apt|Apartment)\b[.,]?\s*(?:(?:#\s*\d+|Apt\s*\w+|Unit\s*\w+)[.,]?)?\s*(?:[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/gi;

// Social profile links (LinkedIn, Twitter/X, GitHub profiles)
const SOCIAL_LINK_REGEX = /https?:\/\/(?:www\.)?(?:linkedin\.com\/(?:in|pub)\/[a-zA-Z0-9_-]+|github\.com\/[a-zA-Z0-9_-]+|twitter\.com\/[a-zA-Z0-9_-]+|x\.com\/[a-zA-Z0-9_-]+)/gi;

export interface SanitizedTextResult {
  sanitizedText: string;
  piiRedacted: {
    emailsCount: number;
    phonesCount: number;
    addressesCount: number;
    linksCount: number;
  };
  originalLength: number;
  sanitizedLength: number;
}

export function scrubPii(text: string, maxCharacters: number = 20000): SanitizedTextResult {
  const originalLength = text.length;

  let emailsCount = 0;
  let phonesCount = 0;
  let addressesCount = 0;
  let linksCount = 0;

  // 1. Redact Emails
  let sanitized = text.replace(EMAIL_REGEX, () => {
    emailsCount++;
    return '[EMAIL REDACTED]';
  });

  // 2. Redact Phone numbers
  sanitized = sanitized.replace(PHONE_REGEX, (match) => {
    // Avoid false positives on isolated 4-digit years like "2020 - 2024"
    if (/^\s*(19|20)\d{2}\s*$/.test(match)) {
      return match;
    }
    phonesCount++;
    return '[PHONE REDACTED]';
  });

  // 3. Redact Social profile URLs
  sanitized = sanitized.replace(SOCIAL_LINK_REGEX, () => {
    linksCount++;
    return '[PROFILE LINK REDACTED]';
  });

  // 4. Redact street addresses
  sanitized = sanitized.replace(ADDRESS_REGEX, () => {
    addressesCount++;
    return '[ADDRESS REDACTED]';
  });

  // 5. Enforce max length / token budget boundary
  if (sanitized.length > maxCharacters) {
    sanitized = sanitized.slice(0, maxCharacters) + '\n\n[TRUNCATED: Exceeded character budget]';
  }

  return {
    sanitizedText: sanitized,
    piiRedacted: {
      emailsCount,
      phonesCount,
      addressesCount,
      linksCount,
    },
    originalLength,
    sanitizedLength: sanitized.length,
  };
}
