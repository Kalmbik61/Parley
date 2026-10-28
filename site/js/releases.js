// Чистые функции разбора релизов: без DOM, чтобы их гонял Node (scripts/site/releases.test.mjs).
// Заметки релиза берутся из тела релиза GitHub, то есть из раздела `## X.Y.Z` файла CHANGELOG.md.

const SECTION_HEADING = /^#{2,4}\s+(.+?)\s*$/
const ANY_HEADING = /^#{1,6}\s/
const SECTIONS = {
  added: 'added',
  changed: 'changed',
  fixed: 'fixed',
  'what is not proven yet': 'notProven',
}
const PR_REFS = /\s*\((?:\[#\d+\]\([^)]*\)(?:,\s*)?)+\)\s*$/
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/** `[текст](url)` → `текст`, без `**`, `__` и обратных кавычек. */
export function stripInline(markdown) {
  return String(markdown ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
}

/** До первой точки, за которой пробел или конец строки; длиннее `max` — по последнему пробелу и `…`. */
export function firstSentence(text, max) {
  const source = String(text ?? '').trim()
  const match = /^[\s\S]*?\.(?=\s|$)/.exec(source)
  const sentence = match ? match[0] : source
  if (sentence.length <= max) return sentence
  const cut = sentence.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${space > 0 ? cut.slice(0, space) : cut}…`
}

export function formatDate(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date)
}

function toItem(raw) {
  const item = raw.replace(PR_REFS, '').trim()
  const bold = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(item)
  if (bold) {
    return {
      title: stripInline(bold[1]).replace(/[.:]\s*$/, '').trim(),
      text: stripInline(bold[2]).trim(),
    }
  }
  return { title: firstSentence(stripInline(item), 110), text: '' }
}

/** Тело релиза → `{ summary, added, changed, fixed, notProven }`. */
export function parseReleaseNotes(body) {
  const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n')
  const notes = { summary: '', added: [], changed: [], fixed: [], notProven: [] }

  const first = lines.findIndex((line) => line.trim() !== '')
  if (first !== -1 && !ANY_HEADING.test(lines[first])) {
    const paragraph = []
    for (let i = first; i < lines.length; i += 1) {
      if (lines[i].trim() === '' || ANY_HEADING.test(lines[i])) break
      paragraph.push(lines[i].trim())
    }
    notes.summary = stripInline(paragraph.join(' '))
  }

  const raw = { added: [], changed: [], fixed: [], notProven: [] }
  let section = null
  let current = null // индекс текущего пункта в raw[section]
  let nested = false // идём по вложенному пункту: его строки не дописываем к родителю
  for (const line of lines) {
    const heading = SECTION_HEADING.exec(line)
    if (heading || ANY_HEADING.test(line)) {
      section = heading ? (SECTIONS[heading[1].toLowerCase()] ?? null) : null
      current = null
      nested = false
      continue
    }
    if (section === null || line.trim() === '') continue
    if (/^[-*]\s+/.test(line)) {
      raw[section].push(line.replace(/^[-*]\s+/, '').trim())
      current = raw[section].length - 1
      nested = false
    } else if (/^\s{2,}[-*]\s/.test(line)) {
      nested = true
    } else if (/^\s/.test(line) && current !== null && !nested) {
      raw[section][current] += ` ${line.trim()}`
    } else if (!/^\s/.test(line)) {
      current = null
      nested = false
    }
  }

  notes.added = raw.added.map(toItem)
  notes.changed = raw.changed.map(toItem)
  notes.fixed = raw.fixed.map(toItem)
  notes.notProven = raw.notProven.map((item) => stripInline(item.trim()))
  return notes
}

/** Релиз GitHub → то, что рисует карточка. */
export function toReleaseCard(release) {
  const notes = parseReleaseNotes(release.body)
  return {
    tag: release.tag_name,
    version: String(release.tag_name ?? '').replace(/^v/, ''),
    name: release.name || release.tag_name,
    url: release.html_url,
    date: release.published_at,
    summary: notes.summary,
    highlights: notes.added.slice(0, 4),
    counts: { added: notes.added.length, changed: notes.changed.length, fixed: notes.fixed.length },
    notProven: notes.notProven,
  }
}

/** Без черновиков и пререлизов, новые первыми. */
export function pickReleases(list, limit = 4) {
  return (Array.isArray(list) ? list : [])
    .filter((release) => !release.draft && !release.prerelease)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, limit)
}
