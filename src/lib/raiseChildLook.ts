/** The handful of choices a parent makes about how the child looks: never a full editor. */
export interface LookOption {
  slug: string;
  label: string;
  /** A CSS colour the layered avatar reads directly. */
  color: string;
}

export const SKIN_TONES: LookOption[] = [
  { slug: 'porcelain', label: 'Porcelain', color: '#F5D9C8' },
  { slug: 'sand', label: 'Sand', color: '#E8C4A0' },
  { slug: 'honey', label: 'Honey', color: '#D3A170' },
  { slug: 'amber', label: 'Amber', color: '#B97D4C' },
  { slug: 'cocoa', label: 'Cocoa', color: '#8A5A36' },
  { slug: 'espresso', label: 'Espresso', color: '#5C3A22' },
];

export const HAIR_STYLES: LookOption[] = [
  { slug: 'short', label: 'Short', color: '#3B2A20' },
  { slug: 'curls', label: 'Curls', color: '#4A2F22' },
  { slug: 'bun', label: 'Bun', color: '#2F2019' },
  { slug: 'braid', label: 'Braid', color: '#5B3B24' },
  { slug: 'buzz', label: 'Buzz', color: '#2A1C15' },
];

export const OUTFIT_COLOURS: LookOption[] = [
  { slug: 'blush', label: 'Blush', color: '#F9A8D4' },
  { slug: 'mint', label: 'Mint', color: '#A7F3D0' },
  { slug: 'lavender', label: 'Lavender', color: '#DDD6FE' },
  { slug: 'sage', label: 'Sage', color: '#CBD5C0' },
  { slug: 'butter', label: 'Butter', color: '#FDE68A' },
  { slug: 'sky', label: 'Sky', color: '#BFDBFE' },
];

export const DEFAULT_LOOK = {
  skin: SKIN_TONES[1].color,
  hair: HAIR_STYLES[1].slug,
  outfit: OUTFIT_COLOURS[0].color,
};

export function lookColour(options: LookOption[], value: string | undefined, fallback: string): string {
  return options.find((option) => option.slug === value || option.color === value)?.color ?? fallback;
}

export function hairFor(value: string | undefined): string {
  return HAIR_STYLES.some((style) => style.slug === value) ? value as string : DEFAULT_LOOK.hair;
}

/** The few words a year is allowed to be described in. Never a number, never a bar. */
export const MOOD_FACES: Record<string, string> = {
  content: 'is content',
  safe: 'feels safe',
  proud: 'is proud of something',
  thoughtful: 'is thinking something over',
  delighted: 'is delighted',
  quiet: 'is quiet today',
  brave: 'was brave today',
  shy: 'is feeling shy',
  curious: 'is curious about everything',
  tender: 'is feeling tender',
  restless: 'has energy to spare',
};

export const MOOD_LABELS = Object.keys(MOOD_FACES);
