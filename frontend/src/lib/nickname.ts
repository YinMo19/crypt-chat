const MAX_NICKNAME_LEN = 32;
const NICKNAME_ALLOWED = /[^A-Za-z0-9 _#]/g;

export function normalizeNickname(input: string): string {
  return input.replace(NICKNAME_ALLOWED, '').slice(0, MAX_NICKNAME_LEN);
}

export function cleanNickname(input: string): string {
  return normalizeNickname(input).trim();
}

export const NICKNAME_MAX_LENGTH = MAX_NICKNAME_LEN;
