/**
 * WHAT AN AI RUN'S TASK MAY SHOW, AND WHERE — found on the farm 2026-09-26.
 *
 * A person wrote an account's PIN and passcode into a task ("pin : 4812, passcode as : 539176"). The
 * agent needs them — it types them — but they were then printed on the AI run list, the run page, the
 * Runs page and the PUBLIC share page. The task stays whole where it is USED (the model, the runner,
 * the owner's own edit box); everywhere it is SHOWN, the values are masked.
 *
 * FOUND BY THEIR LABEL, never by guessing at strings. A value counts when it follows a word that names
 * a secret and a separator — "is", "as", ":" or "=" — so "pin the item to the top" is left alone. The
 * unambiguous labels (password, passcode) also count with only a space, because neither is ever a
 * verb: "log in with password demo1234". What is found is then masked EXACTLY wherever it appears — in
 * the agent's reasoning, a typed step, the summary — because a model repeats what it was told.
 *
 * An unquoted value made only of letters is not taken ("the password is correct" must not mask
 * "correct" everywhere). Quote it to have it hidden: `password "sunshine"`.
 */

const SEPARATED = String.raw`(?:pass\s*(?:word|code|phrase)|pin(?:\s*code)?|otp|one[-\s]?time\s*(?:code|password)|verification\s*code|security\s*code|cvv|cvc|secret|api[-\s]?key|access\s*token|token)`;
const SPACED = String.raw`(?:password|passcode|passphrase)`;
const SEP = String.raw`(?:\s*(?:\bas\b|\bis\b|:|=)\s*)+`;
const VALUE = String.raw`("[^"\n]+"|'[^'\n]+'|[^\s,;]+)`;

const AFTER_SEPARATOR = new RegExp(String.raw`\b${SEPARATED}${SEP}${VALUE}`, 'gi');
const AFTER_SPACE = new RegExp(String.raw`\b${SPACED}\s+${VALUE}`, 'gi');

export const MASK = '••••';

/** The secret values a task names, longest first — so a value never masks half of a longer one. */
export function secretsIn(task: string | null | undefined): string[] {
  const found = new Set<string>();
  for (const re of [AFTER_SEPARATOR, AFTER_SPACE]) {
    for (const m of String(task ?? '').matchAll(re)) {
      const raw = m[1]!;
      const quoted = /^["'].*["']$/.test(raw);
      const value = raw.replace(/^["']|["']$/g, '').replace(/[.)\]}>]+$/, '');
      if (value.length < 3) continue;
      if (!quoted && /^[A-Za-z]+$/.test(value)) continue;
      if (/^(?:as|is)$/i.test(value)) continue;
      found.add(value);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** `text` with every secret value replaced by the mask. Null and undefined pass through. */
export function redact<T extends string | null | undefined>(text: T, secrets: string[]): T {
  if (text === null || text === undefined || !secrets.length) return text;
  let out = String(text);
  for (const s of secrets) out = out.split(s).join(MASK);
  return out as T;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * For the PUBLIC share page only: secrets AND e-mail addresses. A login address is not a secret to
 * the person who owns the farm, and it is exactly what a stranger holding a link should not learn.
 */
export function redactForStrangers<T extends string | null | undefined>(text: T, secrets: string[]): T {
  const masked = redact(text, secrets);
  if (masked === null || masked === undefined) return masked;
  return String(masked).replace(EMAIL, '•••@•••') as T;
}

/**
 * A name for the Runs list, a session or a result, at most `max` characters — cut at a WORD boundary
 * with an ellipsis. The runner used `slice(0, 80)`, which is how "…turn on the setting called
 * \"Quantum teleport mode\". Pa" became a run's name on every page that shows it.
 */
export function clipName(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * What an AI run is called wherever it is listed. Masked first, then clipped, so a secret can never
 * survive by being cut in half.
 */
export function aiRunNames(task: string): { runName: string; sessionName: string; resultName: string } {
  const safe = redact(task, secretsIn(task));
  return {
    runName: `AI: ${clipName(safe, 120)}`,
    sessionName: `AI: ${clipName(safe, 290)}`,
    resultName: `AI: ${clipName(safe, 490)}`,
  };
}

/**
 * The model's reasoning without markup meant for a parser. Some models write their tool call into
 * the prose as well as making it (Qwen: `<tool_call><function=launch_app>…`), and the plan step
 * showed a page of XML to the person reading the run — and to anyone holding a share link.
 */
export function stripToolMarkup<T extends string | null | undefined>(text: T): T {
  if (text === null || text === undefined) return text;
  const clean = String(text)
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<\/?(?:function|parameter)(?:=[^>]*)?>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean as T;
}

/** Every string inside `value` — a step's action, its target — masked, the shape left as it was. */
export function redactDeep<T>(value: T, secrets: string[]): T {
  if (!secrets.length || value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as unknown as T;
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, redactDeep(v, secrets)])) as T;
  }
  return value;
}

/** `redactDeep` for a stranger: secrets and e-mail addresses, in every string inside `value`. */
export function redactDeepForStrangers<T>(value: T, secrets: string[]): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactForStrangers(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeepForStrangers(v, secrets)) as unknown as T;
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, redactDeepForStrangers(v, secrets)])) as T;
  }
  return value;
}
