const VALUE_RE = /^[A-Za-z0-9_\-.:]+$/;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// dotenv (and Next.js, which uses it) allows whitespace before a key and an optional "export ".
const lineRe = (key: string) => new RegExp(`^(\\s*)(export\\s+)?${escapeRegex(key)}\\s*=\\s*(.*)$`);
const eolOf = (s: string) => (s.includes("\r\n") ? "\r\n" : "\n");
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");

export function setEnvValue(content: string | null, key: string, value: string): { content: string; changed: boolean } {
  if (!VALUE_RE.test(value)) throw new Error(`Refusing to write an invalid value for ${key}`);
  if (!content) return { content: `${key}=${value}\n`, changed: true };
  const eol = eolOf(content);
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const i = lines.findIndex((l) => lineRe(key).test(l));
  if (i >= 0) {
    const m = lines[i].match(lineRe(key))!;
    if (unquote(m[3]) === value) return { content, changed: false };
    lines[i] = `${m[1]}${key}=${value}`; // replaced in place, keeping the line's indentation
  } else {
    lines.push(`${key}=${value}`);
  }
  return { content: lines.join(eol) + eol, changed: true };
}

/** True when the file sets `key` to a non-empty value (a commented-out line or another key ending in the same
 * name does not count). */
export function hasEnvValue(content: string | null, key: string): boolean {
  if (!content) return false;
  return content.split(/\r?\n/).some((l) => { const m = l.match(lineRe(key)); return !!m && unquote(m[3]) !== ""; });
}

export function removeEnvValue(content: string | null, key: string): { content: string | null; changed: boolean } {
  if (!content) return { content, changed: false };
  const eol = eolOf(content);
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => !lineRe(key).test(l));
  if (kept.length === lines.length) return { content, changed: false };
  return { content: kept.some((l) => l.trim()) ? kept.join(eol) + eol : null, changed: true };
}

export function addGitignoreLine(content: string | null, line: string): { content: string; changed: boolean } {
  const existing = (content ?? "").split(/\r?\n/).map((l) => l.trim());
  if (existing.includes(line) || existing.includes(`/${line}`)) return { content: content ?? "", changed: false };
  const base = content && !content.endsWith("\n") ? content + "\n" : content ?? "";
  return { content: `${base}${line}\n`, changed: true };
}
