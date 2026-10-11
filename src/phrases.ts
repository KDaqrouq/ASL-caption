/** Nine supported captions from the PRD (full string shown in the subtitle bar). */
export const PHRASES = [
  'ASL Speaker: Can you repeat that?',
  "ASL Speaker: I'm having technical difficulties.",
  "ASL Speaker: Let's take a break.",
  'ASL Speaker: Can you slow down?',
  'ASL Speaker: Goodbye.',
  'ASL Speaker: Thank you.',
  'ASL Speaker: Bless you.',
  'ASL Speaker: Yes.',
  'ASL Speaker: No.',
] as const;

/**
 * ASL glosses suggested for each phrase. The recognizer learns whatever the signer
 * records, so regional variants work as long as they are recorded the same way.
 */
export const GLOSSES = [
  'AGAIN',
  'TECHNICAL PROBLEM',
  'BREAK',
  'SLOW',
  'BYE',
  'THANK-YOU',
  'BLESS-YOU',
  'YES',
  'NO',
] as const;

/** The phrase without the "ASL Speaker:" prefix, for buttons and status text. */
export function shortPhrase(i: number): string {
  return (PHRASES[i] ?? '').replace(/^ASL Speaker:\s*/, '').replace(/\.$/, '');
}
