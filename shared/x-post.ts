// X counts CJK-width characters double and renders every URL as a fixed
// t.co length; mirror that so the admin composer and the worker agree on
// the same remaining-budget number.
export function weightedLength(text: string) {
  let total = 0
  for (const part of text.split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) { total += 23; continue }
    for (const ch of part) total += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠　-〿]/.test(ch) ? 2 : 1
  }
  return total
}
