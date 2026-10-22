import { ContentReuseStatus, LicenseSnapshot, NormalizedQuestionRecord } from './types.js';

export interface ValidationSummary {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export class ImportValidationService {
  /**
   * Validates a normalized question record before staging or publishing.
   */
  public static validateRecord(
    record: NormalizedQuestionRecord,
    reuseStatus: ContentReuseStatus = ContentReuseStatus.PERMITTED
  ): ValidationSummary {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Content size limits
    if (!record.normalizedQuestion || record.normalizedQuestion.trim().length < 10) {
      errors.push('Question text is missing or shorter than 10 characters.');
    } else if (record.normalizedQuestion.length > 10000) {
      errors.push('Question text exceeds 10,000 characters limit.');
    }

    if (!record.normalizedAnswer || record.normalizedAnswer.trim().length === 0) {
      errors.push('Answer content must not be empty.');
    } else if (record.normalizedAnswer.length > 50000) {
      errors.push('Answer content exceeds 50,000 characters limit.');
    }

    // 2. License and copyright validation
    if (!record.licenseSnapshot) {
      errors.push('Missing license snapshot and provenance metadata.');
    } else {
      if (!record.licenseSnapshot.licenseId || record.licenseSnapshot.licenseId.trim() === '') {
        warnings.push('License identifier is unassigned; awaiting copyright permission review.');
      }
    }

    // 3. Content reuse status enforcement
    if (reuseStatus === ContentReuseStatus.RESTRICTED) {
      errors.push('Source is marked RESTRICTED: full question/answer content ingestion is prohibited.');
    } else if (reuseStatus === ContentReuseStatus.METADATA_ONLY) {
      if (record.normalizedAnswer.length > 200) {
        warnings.push('Source allows METADATA_ONLY: full answer content should be truncated or linked directly.');
      }
    }

    // 4. Technology association check
    if (!record.matchedSkillId) {
      warnings.push(`Technology "${record.detectedTechnology || 'Unknown'}" is not mapped to any canonical skill.`);
    }

    // 5. Multiple choice validation
    if (record.questionType === 'MULTIPLE_CHOICE') {
      if (!record.options || record.options.length < 2) {
        warnings.push('Multiple-choice question has fewer than 2 selectable options.');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates license information for a content source.
   */
  public static validateSourceLicense(licenseId?: string | null, reference?: string | null): {
    isPermitted: boolean;
    status: ContentReuseStatus;
    notes: string;
  } {
    if (!licenseId) {
      return {
        isPermitted: false,
        status: ContentReuseStatus.RESTRICTED,
        notes: 'No license recorded. Awaiting permission review.',
      };
    }

    const cleanId = licenseId.trim().toUpperCase();
    const openLicenses = ['MIT', 'APACHE-2.0', 'BSD', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0', 'PUBLIC DOMAIN', 'UNLICENSE', 'ISC'];

    if (openLicenses.some((l) => cleanId.includes(l))) {
      return {
        isPermitted: true,
        status: ContentReuseStatus.PERMITTED,
        notes: `Permissive open-source license (${licenseId}) allows content redistribution with attribution.`,
      };
    }

    if (cleanId.includes('CC-BY-NC') || cleanId.includes('NON-COMMERCIAL')) {
      return {
        isPermitted: true,
        status: ContentReuseStatus.METADATA_ONLY,
        notes: `Non-commercial license (${licenseId}) requires metadata-only and original attribution linking.`,
      };
    }

    return {
      isPermitted: false,
      status: ContentReuseStatus.RESTRICTED,
      notes: `License (${licenseId}) requires manual rights review before full redistribution can be approved.`,
    };
  }
}
