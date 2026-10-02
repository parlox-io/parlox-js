// Text from files, from the package manager and from the flow, made safe to draw and cut into rows that fit. Shared by
// both faces; it loads nothing (the plain face must not load Ink or React).

/** Characters a terminal draws two columns wide: those Unicode classes East Asian Wide or Fullwidth (the CJK and
 * Hangul blocks, kana, fullwidth forms, emoji shown as emoji). JavaScript cannot test that class itself, so this is
 * a superset of it built from the scripts and blocks it covers: it also takes in a few narrow characters (halfwidth
 * katakana, Hangul vowel jamo, emoji-block symbols shown as text), which only end their row a column early. A row cut
 * to a width is never wider than that on screen. */
const WIDE = /[\p{Emoji_Presentation}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Yi}\u2329\u232A\u2E80-\u303E\u3041-\u33FF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{1B2FF}\u{1F200}-\u{1F2FF}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const columns = (ch: string) => (ch.charCodeAt(0) < 0x1100 ? 1 : WIDE.test(ch) ? 2 : 1);

/** Characters that change how the text around them is shown without showing themselves: format characters (Unicode
 * category Cf: the bidirectional overrides and isolates, zero-width spaces and joiners, the byte-order mark, tag
 * characters) and the line and paragraph separators. A diff holding them can read differently from what is written
 * (the "Trojan Source" attacks), so they are written out. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
const codeOf = (c: number) => `<U+${c.toString(16).toUpperCase().padStart(4, "0")}>`;

/** A line as a terminal pager shows it, so that what is drawn is exactly what is there: every control character
 * written out (^M for a carriage return, ^[ for an escape, as less does), the C1 controls and the invisible
 * characters above as <U+XXXX>. A file or a command's output then can neither move the cursor, restyle the screen,
 * nor hide or reorder text. Tabs are expanded to the next multiple of 8 columns (as `git diff` shows them in less),
 * or kept with `keepTabs` where the terminal lays them out itself (the plain face). */
export function printable(line: string, { keepTabs = false }: { keepTabs?: boolean } = {}): string {
  let out = "", col = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0)!;
    let shown: string;
    if (ch === "\t") {
      const to = 8 - (col % 8);
      col += to;
      out += keepTabs ? ch : " ".repeat(to);
      continue;
    }
    if (c < 0x20 || c === 0x7f) shown = `^${String.fromCharCode(c === 0x7f ? 0x3f : c + 0x40)}`;
    else if ((c >= 0x80 && c <= 0x9f) || INVISIBLE.test(ch)) shown = codeOf(c);
    else { out += ch; col += columns(ch); continue; }
    out += shown; col += shown.length;
  }
  return out;
}

/** Text that may run over several lines (a message, a snippet): each line made printable, the line breaks kept. */
export const printableLines = (text: string): string => text.split("\n").map((l) => printable(l)).join("\n");

/** Columns a printable string takes, counted as above. */
export function widthOf(text: string): number {
  let w = 0;
  for (const ch of text) w += columns(ch);
  return w;
}

/** A printable line cut into rows of at most `width` columns, in order: a long line continues on the next row, so
 * nothing is cut off. An empty line is one empty row. */
export function rowsOf(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = "", used = 0;
  for (const ch of line) {
    const w = columns(ch);
    if (used + w > width && row) { rows.push(row); row = ""; used = 0; }
    row += ch; used += w;
  }
  rows.push(row);
  return rows;
}

/** A printable line wrapped at spaces into rows of at most `width` columns, a word longer than a row cut across rows
 * (a link, say). Drawn row by row, the screen never wraps it again, so its height is known before it is drawn. */
export function wrapWords(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  // Each word keeps the spaces after it; they are dropped at the end of a row.
  for (const word of line.match(/[^ ]*( +|$)/g) ?? []) {
    if (!word) continue;
    if (widthOf((row + word).trimEnd()) <= width) { row += word; continue; }
    // A row holding only an indent keeps it in front of the word that is cut.
    const indent = row.trim() ? "" : row;
    if (row.trim()) rows.push(row.trimEnd());
    const pieces = rowsOf(indent + word.trimEnd(), width);
    for (const piece of pieces.slice(0, -1)) rows.push(piece);
    row = pieces[pieces.length - 1] + word.slice(word.trimEnd().length);
  }
  rows.push(row.trimEnd());
  return rows;
}
