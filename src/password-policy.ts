import { dictionary } from '@zxcvbn-ts/language-common';
import { RosterError } from './database.ts';
import { maxPasswordLength, minPasswordLength } from './password-limits.ts';

export const organizerUsernamePattern = /^[a-z0-9][a-z0-9_.-]{2,39}$/;

const commonPasswords = new Set(dictionary['passwords-common'].map((password) => password.normalize('NFC').toLowerCase()));
const predictablePatterns = ['0', '1', 'a', '0123456789', '1234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'rosterready'];
for (const pattern of predictablePatterns) {
  const repeated = pattern.repeat(Math.ceil(maxPasswordLength / pattern.length));
  for (let length = minPasswordLength; length <= maxPasswordLength; length++) {
    commonPasswords.add(repeated.slice(0, length));
  }
}

export function validateNewPassword(password: unknown, username: string): string {
  const normalized = typeof password === 'string' ? password.normalize('NFC') : '';
  const length = [...normalized].length;
  if (length < minPasswordLength || length > maxPasswordLength) {
    throw new RosterError(400, `Use a password of ${minPasswordLength} to ${maxPasswordLength} characters.`);
  }

  const comparison = normalized.toLowerCase();
  const trimmed = comparison.trim();
  if (!trimmed || commonPasswords.has(comparison) || commonPasswords.has(trimmed) || trimmed === username) {
    throw new RosterError(400, 'This password is too common or easy to guess. Choose a different password.');
  }
  return normalized;
}
