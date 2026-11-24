// Canonical text index for a rendered section: one flat string over the
// document's text nodes, an offset mapping back to (node, offset) pairs, and
// sentence boundaries that never cross an element break. Pure DOM work — no
// geometry — so it can be built outside the rendered iframe and tested in
// jsdom. The app owns the lifecycle and the locale-specific cache.

const REJECT_TAGS = new Set(['script', 'style', 'rt', 'rp', 'noscript', 'svg', 'math'])

// Elements whose presence starts a new sentence: `<br>`/`<hr>` are hard breaks,
// block containers never let a sentence span them.
const BREAK_TAGS = new Set(['br', 'hr', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'tr', 'td', 'th', 'section', 'article', 'pre', 'figure', 'figcaption',
    'aside', 'header', 'footer', 'dt', 'dd', 'ul', 'ol', 'table'])

// A segment shorter than this is a fragment ("Да.", "Нет.") and is merged
// forward. 40 from the plan merged complete 19–23 character sentences and so
// contradicted its own acceptance cases (A2 §9.1.4/9.1.6 expect two sentences).
const SEG_MIN_CHARS = 16
const MAX_RECTS = 400             // documented cap for consumers drawing a sentence

const ABBREV_EN = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|Fig|No|Vol|pp|al|cf)|\be\.g|\bi\.e|\betc)\.$/i
const ABBREV_RU = /(?:\b(?:т\.\s?е|т\.\s?д|т\.\s?к|г|гг|стр|рис|см|др|им|проф|акад|тов|руб|млн|млрд|тыс|ул|пер|кв|обл|респ|н\.\s?э|вв)\.|[А-ЯЁA-Z]\.|[А-ЯЁ]\.\s?[А-ЯЁ]\.)$/u

// Numeric NodeFilter constants: the walker is shared between documents whose
// globals may not be the current window's.
const FILTER_ACCEPT = 1
const FILTER_REJECT = 2
const FILTER_SKIP = 3
const SHOW_ELEMENT = 0x1
const SHOW_TEXT = 0x4
const SHOW_CDATA_SECTION = 0x8
const SHOW = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

const WS = /\s/

const isElement = node => node.nodeType === 1
const isTextual = node => node.nodeType === 3 || node.nodeType === 4

// Elements must be accepted (so their position becomes a break) or rejected
// (so their subtree is skipped). `text-walker.js` skips every element, which is
// why it cannot report `<br>`/paragraph boundaries.
const acceptNode = node => {
    if (isElement(node)) {
        const name = node.tagName.toLowerCase()
        if (REJECT_TAGS.has(name)) return FILTER_REJECT
        if (BREAK_TAGS.has(name)) return FILTER_ACCEPT
        return FILTER_SKIP
    }
    return FILTER_ACCEPT
}

// FNV-1a, 32 bit, over UTF-16 code units. Only used as a cache key.
const fnv1a = text => {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

const lowerBound = (sorted, value) => {
    let lo = 0, hi = sorted.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sorted[mid] < value) lo = mid + 1
        else hi = mid
    }
    return lo
}

// A break anywhere in [start, end] (inclusive) forbids joining across it.
const hasBreak = (breaks, start, end) => {
    const at = lowerBound(breaks, start)
    return at < breaks.length && breaks[at] <= end
}

const intlSegments = (text, locale) => {
    const out = []
    const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })
    for (const { index, segment } of segmenter.segment(text))
        out.push([index, index + segment.length])
    return out
}

// Last-resort splitter for engines without `Intl.Segmenter`; abbreviation
// merging below still applies, so behaviour degrades rather than breaks.
const regexSegments = text => {
    const out = []
    const re = /(?<=[.!?…])\s+/gu
    let start = 0
    for (const match of text.matchAll(re)) {
        const end = match.index
        if (end > start) out.push([start, end])
        start = match.index + match[0].length
    }
    if (start < text.length) out.push([start, text.length])
    return out
}

const rawSegments = (text, locale) => {
    try {
        if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
            return intlSegments(text, locale)
    } catch {
        // Unknown locale: fall through to the regex splitter.
    }
    return regexSegments(text)
}

const splitAtBreaks = (sentences, breaks) => {
    const out = []
    for (const [start, end] of sentences) {
        const from = lowerBound(breaks, start + 1)
        let cursor = start
        for (let i = from; i < breaks.length && breaks[i] < end; i++) {
            out.push([cursor, breaks[i]])
            cursor = breaks[i]
        }
        out.push([cursor, end])
    }
    return out
}

const trimSentence = (text, sentence) => {
    let [start, end] = sentence
    while (start < end && WS.test(text[start])) start++
    while (end > start && WS.test(text[end - 1])) end--
    return [start, end]
}

const isAbbreviation = sentence => ABBREV_EN.test(sentence) || ABBREV_RU.test(sentence)

// `т.е.` / `Mr.` / `А. С.` end a native sentence segment but not a real one.
// Merging runs backwards so an initial keeps chaining onto the next initial.
const mergeAbbreviations = (sentences, text, breaks) => {
    for (let i = sentences.length - 2; i >= 0; i--) {
        const current = sentences[i]
        const next = sentences[i + 1]
        if (!next) continue
        if (hasBreak(breaks, current[1], next[0])) continue
        if (!isAbbreviation(text.slice(current[0], current[1]))) continue
        current[1] = next[1]
        sentences.splice(i + 1, 1)
    }
    return sentences
}

// Closing quotes and brackets that may trail the punctuation of a sentence
// ("Он ушёл».", "Done!)"). They never end a sentence on their own.
const CLOSERS = /[»"'\u2018\u2019\u201A\u201C\u201D\u201E\u2039\u203A)\]]$/
const TERMINAL = /[.!?…]$/

// Whether the segment already ends a sentence, ignoring trailing closers. A
// complete short sentence ("Да.") is a valid translation unit on its own, so it
// must not be glued to the next one; only a fragment that stops without
// terminal punctuation is merged forward.
const endsSentence = sentence => {
    let end = sentence.length
    while (end > 0 && CLOSERS.test(sentence.slice(0, end))) end--
    if (end === 0) return true
    return TERMINAL.test(sentence.slice(0, end))
}

// Short fragments are not useful translation units; merge forward until stable,
// but never across a hard break and never past a finished sentence.
const mergeShort = (sentences, text, breaks) => {
    let merged = true
    while (merged) {
        merged = false
        for (let i = 0; i < sentences.length - 1; i++) {
            const current = sentences[i]
            const next = sentences[i + 1]
            if (current[1] - current[0] >= SEG_MIN_CHARS) continue
            if (endsSentence(text.slice(current[0], current[1]))) continue
            if (hasBreak(breaks, current[1], next[0])) continue
            current[1] = next[1]
            sentences.splice(i + 1, 1)
            merged = true
            break
        }
    }
    return sentences
}

const segment = (text, breaks, locale) => {
    if (!text.length) return []
    const split = splitAtBreaks(rawSegments(text, locale), breaks)
    const trimmed = []
    for (const sentence of split) {
        const [start, end] = trimSentence(text, sentence)
        if (end > start) trimmed.push([start, end])
    }
    mergeAbbreviations(trimmed, text, breaks)
    mergeShort(trimmed, text, breaks)
    return trimmed
}

/**
 * Build the canonical text index of a rendered document.
 *
 * @param {Node} root Usually `document.body`.
 * @param {{ locale?: string }} [options] Explicit locale wins over the
 *   document language (`root.lang` → `documentElement.lang` → `'en'`).
 */
export const buildTextIndex = (root, options = {}) => {
    const doc = root.ownerDocument ?? root
    const locale = options.locale ?? (root.lang || doc.documentElement?.lang || 'en')

    const walker = doc.createTreeWalker(root, SHOW, { acceptNode })
    const nodes = []
    const nodeMap = new Map()
    const breaks = []
    let text = ''

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (isElement(node)) {
            breaks.push(text.length)
            continue
        }
        if (!isTextual(node)) continue
        const value = node.nodeValue ?? ''
        if (!value.length) continue
        const entry = { node, start: text.length, end: text.length + value.length }
        nodes.push(entry)
        nodeMap.set(node, entry)
        text += value
    }

    return {
        text,
        nodes,
        nodeMap,
        breaks,
        sentences: segment(text, breaks, locale),
        hash: fnv1a(text),
        locale,
    }
}

// Largest node index whose `start` is <= offset (same rule as search.js).
const nodeAt = (nodes, offset) => {
    let lo = 0, hi = nodes.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (nodes[mid].start <= offset) lo = mid
        else hi = mid - 1
    }
    return lo
}

/**
 * Map a flat `[start, end)` slice back to a live DOM Range.
 *
 * @param {{ nodes: Array<{ node: Node, start: number, end: number }> }} index
 * @param {number} start
 * @param {number} end
 * @returns {Range | null} `null` when empty, unmapped or out of bounds.
 */
export const rangeFromOffsets = (index, start, end) => {
    const { nodes } = index
    if (!nodes.length) return null
    const last = nodes[nodes.length - 1]
    const limit = last.end
    const from = Math.max(0, Math.min(start, limit))
    const to = Math.max(0, Math.min(end, limit))
    if (to <= from) return null
    const startNode = nodes[nodeAt(nodes, from)]
    const endNode = nodes[nodeAt(nodes, to)]
    const doc = startNode.node.ownerDocument
    if (!doc) return null
    const range = doc.createRange()
    range.setStart(startNode.node, Math.min(from - startNode.start, startNode.end - startNode.start))
    range.setEnd(endNode.node, Math.min(to - endNode.start, endNode.end - endNode.start))
    return range
}

const firstIndexedDescendant = (index, node) => {
    if (isTextual(node)) return index.nodeMap.get(node) ?? null
    if (!node.childNodes) return null
    for (const child of node.childNodes) {
        const found = firstIndexedDescendant(index, child)
        if (found) return found
    }
    return null
}

const lastIndexedDescendant = (index, node) => {
    if (isTextual(node)) return index.nodeMap.get(node) ?? null
    if (!node.childNodes) return null
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const found = lastIndexedDescendant(index, node.childNodes[i])
        if (found) return found
    }
    return null
}

/**
 * Flat offset of a caret position `(node, offset)`.
 *
 * @param {ReturnType<typeof buildTextIndex>} index
 * @param {Node} node
 * @param {number} offset
 * @returns {number} `-1` when the position cannot be mapped.
 */
export const offsetFromPosition = (index, node, offset) => {
    if (!node) return -1
    const entry = index.nodeMap.get(node)
    if (entry) {
        const inNode = Math.max(0, Math.min(offset, entry.end - entry.start))
        return entry.start + inNode
    }
    if (!node.childNodes) return -1
    const from = Math.max(0, Math.min(offset, node.childNodes.length))
    for (let i = from; i < node.childNodes.length; i++) {
        const found = firstIndexedDescendant(index, node.childNodes[i])
        if (found) return found.start
    }
    for (let i = Math.min(from, node.childNodes.length) - 1; i >= 0; i--) {
        const found = lastIndexedDescendant(index, node.childNodes[i])
        if (found) return found.end
    }
    return -1
}

/**
 * Index of the sentence containing `offset`, or the closest preceding one when
 * the offset falls into whitespace between sentences.
 *
 * @param {ReturnType<typeof buildTextIndex>} index
 * @param {number} offset
 * @returns {number} `-1` outside the text.
 */
export const sentenceAt = (index, offset) => {
    const sentences = index.sentences
    if (!sentences.length || offset < 0 || offset >= index.text.length) return -1
    let lo = 0, hi = sentences.length - 1, found = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (sentences[mid][0] <= offset) {
            found = mid
            lo = mid + 1
        } else hi = mid - 1
    }
    return found
}

export { MAX_RECTS }
