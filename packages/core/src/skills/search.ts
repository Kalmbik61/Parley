import type { NativeSkill } from './types.js';

// Fixed local BM25 parameters. Name/description are normalized independently; name has ×3 boost.
const K1 = 1.2;
const B = 0.75;
const NAME_WEIGHT = 3;
const STOP_WORDS = new Set(
  'a an and are as at be been being by for from had has have he her his i in is it its of on or our she that the their them there these they this those to was we were will with you your'.split(' '),
);

/**
 * Основа слова: срез суффикса, затем удвоенная согласная после `ing`/`ed` и конечная `e`, чтобы write/writing,
 * make/making, debug/debugging, plan/planning, slide/slides совпадали (иначе «write» и «writ» из «writing»
 * расходятся). Удвоение схлопывается только у g, m, n, p, t: у l, s, z, d, b, r основа слова сама может
 * оканчиваться двойной (call, pass, add, err). Не лингвистический стеммер, а детерминированная нормализация:
 * одно слово всегда даёт одну основу, внешних моделей нет.
 */
function stem(word: string): string {
  let result = word;
  // A small suffix trimmer; always retain at least two letters.
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 2) {
      result = word.slice(0, -suffix.length);
      if ((suffix === 'ing' || suffix === 'ed') && /([gmnpt])\1$/.test(result)) result = result.slice(0, -1);
      break;
    }
  }
  return result.length > 2 && result.endsWith('e') ? result.slice(0, -1) : result;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).filter(word => !STOP_WORDS.has(word)).map(stem);
}

function frequencies(words: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const word of words) result.set(word, (result.get(word) ?? 0) + 1);
  return result;
}

const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export interface SkillSearchMatch {
  skill: NativeSkill;
  score: number;
}

/** Search an already-resolved session inventory. No body reads, filesystem traversal or CLI calls. */
export function searchSkills(
  skills: readonly NativeSkill[],
  query: string,
  limit = 5,
): SkillSearchMatch[] {
  if (!query.trim()) throw new Error('Skill search query must not be empty.');
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Skill search limit must be a positive integer.');
  const words = [...new Set(tokens(query))];
  if (words.length === 0) return [];
  // Hidden records must affect neither candidates nor corpus length/document-frequency statistics.
  const documents = skills.filter(skill => skill.modelAvailable).map(skill => {
    const name = tokens(skill.name);
    const description = tokens(skill.description);
    return {
      skill,
      name: frequencies(name),
      description: frequencies(description),
      nameLength: name.length,
      descriptionLength: description.length,
    };
  });
  if (documents.length === 0) return [];
  const averageName = documents.reduce((sum, doc) => sum + doc.nameLength, 0) / documents.length;
  const averageDescription = documents.reduce((sum, doc) => sum + doc.descriptionLength, 0) / documents.length;
  const fieldScore = (count: number, length: number, average: number): number => {
    if (count === 0) return 0;
    return count * (K1 + 1) / (count + K1 * (1 - B + B * length / (average || 1)));
  };
  const matches: SkillSearchMatch[] = documents.map(doc => ({ skill: doc.skill, score: 0 }));
  for (const word of words) {
    const frequency = documents.filter(doc => doc.name.has(word) || doc.description.has(word)).length;
    if (frequency === 0) continue;
    // idf = ln(1 + (N - df + 0.5)/(df + 0.5)); score = idf × (3×BM25(name) + BM25(description)).
    const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
    documents.forEach((doc, index) => {
      const match = matches[index];
      if (match) match.score += idf * (
        NAME_WEIGHT * fieldScore(doc.name.get(word) ?? 0, doc.nameLength, averageName) +
        fieldScore(doc.description.get(word) ?? 0, doc.descriptionLength, averageDescription)
      );
    });
  }
  return matches.filter(match => match.score > 0).sort((a, b) =>
    b.score - a.score || compare(a.skill.name, b.skill.name) || compare(a.skill.path, b.skill.path),
  ).slice(0, Math.min(limit, 10));
}
