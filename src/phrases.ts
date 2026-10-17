/** A phrase the signer can teach; captions read "ASL Speaker: <text>". */
export type Phrase = {
  /** Stable id; examples refer to it, so phrases can be added and removed freely. */
  id: string;
  text: string;
  /** Suggested ASL gloss for the built-in phrases. */
  gloss?: string;
};

export const CAPTION_PREFIX = 'ASL Speaker: ';
export const MAX_PHRASES = 30;
export const MAX_PHRASE_LENGTH = 80;

/** The nine phrases from the PRD; used until the signer changes the list. */
export const DEFAULT_PHRASES: readonly Phrase[] = [
  { id: 'p1', text: 'Can you repeat that?', gloss: 'AGAIN' },
  { id: 'p2', text: "I'm having technical difficulties.", gloss: 'TECHNICAL PROBLEM' },
  { id: 'p3', text: "Let's take a break.", gloss: 'BREAK' },
  { id: 'p4', text: 'Can you slow down?', gloss: 'SLOW' },
  { id: 'p5', text: 'Goodbye.', gloss: 'BYE' },
  { id: 'p6', text: 'Thank you.', gloss: 'THANK-YOU' },
  { id: 'p7', text: 'Bless you.', gloss: 'BLESS-YOU' },
  { id: 'p8', text: 'Yes.', gloss: 'YES' },
  { id: 'p9', text: 'No.', gloss: 'NO' },
];

/** Id of a built-in phrase by its original position (examples saved before custom phrases existed). */
export function legacyPhraseId(index: number): string {
  return `p${index + 1}`;
}

export function caption(p: Phrase): string {
  return CAPTION_PREFIX + p.text;
}

/** The phrase without a trailing full stop, for buttons and status text. */
export function shortText(p: Phrase): string {
  return p.text.replace(/\.$/, '');
}

/** Normalises user-typed phrase text; returns null when there is nothing usable. */
export function cleanPhraseText(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim().replace(new RegExp(`^${CAPTION_PREFIX.trim()}\\s*`, 'i'), '');
  return t ? t.slice(0, MAX_PHRASE_LENGTH) : null;
}

export function newPhraseId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
