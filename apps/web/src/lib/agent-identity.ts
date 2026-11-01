/** Each agent keeps its letters and gradient everywhere (Foundations: agent identity). */
const GRADIENTS: [string, string, string][] = [
  ['chief', '#b39dff', '#ff6ad5'],
  ['architect', '#7db4ff', '#4fe3ff'],
  ['designer', '#ff6ad5', '#ffa66b'],
  ['frontend', '#ffa66b', '#ffe14d'],
  ['backend', '#4fe3ff', '#8f9bff'],
  ['developer', '#b8f25a', '#3df5c8'],
  ['qa', '#ffe14d', '#b8f25a'],
  ['security', '#ff7f9e', '#ffa66b'],
  ['devops', '#3df5c8', '#4fe3ff'],
  ['researcher', '#d2c4ff', '#9cc8ff'],
];

/**
 * Two letters, the way the Foundations artboard spells them: an acronym first word keeps itself (QA),
 * two words take their initials (Frontend Dev → FD), one word takes its first letter and the next
 * consonant (Developer → DV, Designer → DS, Chief → CH).
 */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (/^[A-Z]{2,3}$/.test(words[0])) return words[0].slice(0, 2);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0];
  const next = w.slice(1).match(/[^aeiou]/i)?.[0] ?? w[1] ?? '';
  return (w[0] + next).toUpperCase();
}

/** Gradient stops for a slug or role; unknown names hash onto the palette so they stay stable. */
export function agentGradient(key: string): [string, string] {
  const k = key.toLowerCase();
  const hit = GRADIENTS.find(([name]) => k.includes(name));
  if (hit) return [hit[1], hit[2]];
  let h = 0;
  for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const g = GRADIENTS[h % GRADIENTS.length];
  return [g[1], g[2]];
}
