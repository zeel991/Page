/** A value the service computed is impossible; the request fails rather than charging it. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
