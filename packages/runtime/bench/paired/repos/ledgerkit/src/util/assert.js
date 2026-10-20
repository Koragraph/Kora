import { ValidationError } from '../errors.js';

export function assertInteger(value, name) {
  if (!Number.isInteger(value)) throw new ValidationError(`${name} must be an integer, got ${value}`);
}

export function assertPositive(value, name) {
  if (!(value > 0)) throw new ValidationError(`${name} must be positive, got ${value}`);
}

export function assertPresent(value, name) {
  if (value === undefined || value === null || value === '') throw new ValidationError(`${name} is required`);
}
