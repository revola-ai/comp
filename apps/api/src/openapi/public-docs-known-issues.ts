import type { collectPublicOpenApiIssues } from './public-docs-quality';

export type PublicOpenApiIssues = ReturnType<typeof collectPublicOpenApiIssues>;

/**
 * The public spec's issues as of this commit (collectPublicOpenApiIssues),
 * which openapi-docs.spec.ts asserts exactly. Any new issue, a private
 * surface leaking into the spec included, fails it; fixing one fails it too
 * until its entry is deleted here, so this list only shrinks.
 * Never add an entry; fix the endpoint's docs or exclusion instead.
 */
export const KNOWN_PUBLIC_OPENAPI_ISSUES: PublicOpenApiIssues = {
  excludedPaths: [],
  exposedTags: [],
  // ISMS endpoints whose x-mint SEO title or description fails the checks.
  invalidSeo: [
    'DELETE /v1/isms/documents/{id}/controls/{controlId}',
    'DELETE /v1/isms/registers/{register}/{rowId}',
    'GET /v1/isms/documents/{id}',
    'GET /v1/isms/documents/{id}/drift',
    'GET /v1/isms/documents/{id}/versions',
    'GET /v1/isms/profile',
    'PATCH /v1/isms/registers/{register}/{rowId}',
    'POST /v1/isms/documents/{id}/approve',
    'POST /v1/isms/documents/{id}/controls',
    'POST /v1/isms/documents/{id}/decline',
    'POST /v1/isms/documents/{id}/export',
    'POST /v1/isms/documents/{id}/generate',
    'POST /v1/isms/documents/{id}/narrative',
    'POST /v1/isms/documents/{id}/registers/{register}',
    'POST /v1/isms/documents/{id}/submit-for-approval',
    'POST /v1/isms/ensure-setup',
    'POST /v1/isms/generate-all',
    'POST /v1/isms/profile',
  ],
  missingMetadata: [],
  missingSummaries: [],
  sensitiveSchemaDetails: [],
};

/** Each issue list sorted, so the comparison ignores route registration order. */
export function sortPublicOpenApiIssues(
  issues: PublicOpenApiIssues,
): PublicOpenApiIssues {
  return {
    excludedPaths: [...issues.excludedPaths].sort(),
    exposedTags: [...issues.exposedTags].sort(),
    invalidSeo: [...issues.invalidSeo].sort(),
    missingMetadata: [...issues.missingMetadata].sort(),
    missingSummaries: [...issues.missingSummaries].sort(),
    sensitiveSchemaDetails: [...issues.sensitiveSchemaDetails].sort(),
  };
}
