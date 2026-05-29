/**
 * User color assignment.
 *
 * memberId (server-issued, identical across clients) → stable hue. With a
 * dark grey background we hold S/L fixed so every color reads as a light
 * tint — only the hue shifts per user.
 */

export function colorFor(memberId: string): string {
  // FNV-1a 32-bit hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < memberId.length; i++) {
    h ^= memberId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = (h >>> 0) % 360;
  // Light but not washed out: S=55%, L=78% has enough contrast on #171717.
  return `hsl(${hue} 55% 78%)`;
}
