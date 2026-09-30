export class InvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvariantError';
  }
}

export function invariant(condition, message) {
  if (!condition) throw new InvariantError(message);
}
