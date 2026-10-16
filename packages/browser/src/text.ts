// Cuts and trims for strings that leave the page, shared by the tracker and the URL rule (url.ts).

// The first n characters of s, an emoji counted as one: a cut never leaves half of one. An unpaired surrogate already in
// s becomes U+FFFD, because a database that stores JSON (Postgres jsonb) refuses one, and so does encodeURIComponent.
export function cut(s: string, n: number): string {
  let out = "";
  for (let i = 0, count = 0; i < s.length && count < n; i++, count++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { out += s[i] + s[i + 1]; i++; } else out += "�";
    } else out += c >= 0xdc00 && c <= 0xdfff ? "�" : s[i];
  }
  return out;
}

// s without the run of one character (by code) at its end, in one pass. A pattern such as /,+$/ takes the square of
// the string's length when a long run is not at the end.
export function trimEnd(s: string, code: number): string {
  let e = s.length;
  while (e && s.charCodeAt(e - 1) === code) e--;
  return s.slice(0, e);
}
