/**
 * URL-building for vendor resource paths.
 *
 * Several of these values are chosen by a model or arrive in a payload — a file
 * path, a ref, an issue key, a page id — and interpolating them raw lets `../` or a
 * `/` walk to a different resource than the one asked about. Each value is
 * validated and encoded, so it can only ever name one path segment.
 */
export class UnsafeRepositoryPathError extends Error {
  constructor(what: string, value: string) {
    super(`Refusing unsafe ${what}: ${JSON.stringify(value)}`);
    this.name = 'UnsafeRepositoryPathError';
  }
}

/** One path segment: never empty, never `.` or `..`, always encoded (so `/` cannot split it). */
export function segment(value: string, what = 'path segment'): string {
  if (value === '' || value === '.' || value === '..') throw new UnsafeRepositoryPathError(what, value);
  return encodeURIComponent(value);
}
