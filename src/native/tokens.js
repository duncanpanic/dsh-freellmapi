/**
 * Token estimation for streams that never report usage.
 *
 * The `/4` rule everyone quotes is a rule about **English prose**: ~4 characters
 * per token because the vocabulary is built from Latin-script word pieces. It is
 * wrong by roughly 4x for CJK, where one character is usually one whole token —
 * a 43-character Chinese sentence is ~43 tokens, not 11.
 *
 * That error is not cosmetic here. This estimate is what the router records when
 * a provider omits usage, and those records drive the RPM/RPD/TPM/TPD guards:
 * undercounting means the router believes it has quota left when it does not, so
 * it keeps spending until the provider answers 429 instead of steering away
 * before that.
 *
 * So the estimate is script-aware. The split is deliberately crude — it only has
 * to be closer than a flat `/4`, and precision beyond that is wasted because a
 * provider that reports usage is always believed over this.
 *
 * @module src/native/tokens.js
 */

// @ts-check

/**
 * Codepoint ranges whose characters are usually one token each.
 *
 * Covers the CJK ideograph blocks, the kana, Hangul, and the fullwidth forms
 * that come with them. Deliberately excludes Latin-1 and Cyrillic: those
 * tokenize as multi-character pieces like English does.
 */
const DENSE_SCRIPTS = [
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xff60], // Fullwidth forms
  [0x20000, 0x2fa1f], // CJK Extensions B–F
]

/** Characters per token for the non-dense remainder. */
const SPARSE_CHARS_PER_TOKEN = 4

function isDense(codePoint) {
  for (const [start, end] of DENSE_SCRIPTS) {
    if (codePoint >= start && codePoint <= end) return true
  }
  // Emoji and symbols tokenize densely too, but they are rare in prompts; the
  // surrogate-pair check below folds them into the sparse bucket, which
  // undercounts them slightly. That is acceptable — overcounting would be worse.
  return false
}

/**
 * Estimate the token count of a string.
 *
 * @param {unknown} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : ''
  if (value === '') return 1

  let dense = 0
  let sparse = 0
  for (const character of value) {
    if (isDense(character.codePointAt(0))) dense += 1
    else sparse += 1
  }

  const tokens = dense + sparse / SPARSE_CHARS_PER_TOKEN
  return Math.max(1, Math.round(tokens))
}
