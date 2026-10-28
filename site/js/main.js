// Точка входа. Всё, что прячет содержимое до появления, включается только здесь: без JS страница видна целиком.
import { firstSentence, formatDate, pickReleases, toReleaseCard } from './releases.js'
import { initRoom } from './room-demo.js'
import { initIsland } from './island.js'

const root = document.documentElement
root.classList.add('js')

const header = document.querySelector('.site-header')
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8)
onScroll()
window.addEventListener('scroll', onScroll, { passive: true })

const year = document.getElementById('year')
if (year) year.textContent = String(new Date().getFullYear())

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const items = document.querySelectorAll('[data-reveal]')
if (!reduceMotion && 'IntersectionObserver' in window) {
  items.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.hasAttribute('data-reveal'))
    el.style.transitionDelay = `${siblings.indexOf(el) * 60}ms`
    el.classList.add('reveal')
  })
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        const el = e.target
        el.classList.add('in')
        io.unobserve(el)
        // Когда появление закончилось, возвращаем элементу обычные переходы (наведение на карточку).
        el.addEventListener('transitionend', (ev) => {
          if (ev.target !== el || ev.propertyName !== 'opacity') return
          el.classList.remove('reveal', 'in')
          el.style.transitionDelay = ''
        })
      })
    },
    { threshold: 0.12 }
  )
  items.forEach((el) => io.observe(el))
}

// Релизы: снимок site/releases.json, который пишет workflow публикации. Весь текст релиза идёт через textContent.
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const countsLine = ({ added, changed, fixed }) =>
  [
    [added, 'added'],
    [changed, 'changed'],
    [fixed, 'fixed'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')

const dateNode = (card) => {
  const time = el('time', 'release-date', formatDate(card.date))
  time.dateTime = card.date
  return time
}

function latestCard(card) {
  const a = el('a', 'card release release-latest')
  a.href = card.url
  const meta = el('p', 'release-meta')
  meta.append(el('span', 'tag tag-question', 'Latest'), el('span', 'mono', `v${card.version}`), dateNode(card))
  a.append(meta, el('h3', '', card.name))
  if (card.summary) a.append(el('p', 'release-summary', card.summary))
  if (card.highlights.length) {
    const ul = el('ul', 'release-highlights')
    for (const { title, text } of card.highlights) {
      const li = el('li')
      li.append(el('strong', text ? 'has-text' : '', title))
      if (text) li.append(` ${firstSentence(text, 140)}`)
      ul.append(li)
    }
    a.append(ul)
  }
  const counts = countsLine(card.counts)
  if (counts) a.append(el('p', 'release-counts', counts))
  if (card.notProven[0]) {
    const np = el('div', 'release-np')
    np.append(el('span', 'release-np-label', 'Not proven yet'), el('p', '', card.notProven[0]))
    a.append(np)
  }
  a.append(el('span', 'release-more', 'Read the release notes →'))
  return a
}

function compactCard(card) {
  const a = el('a', 'card release release-compact')
  a.href = card.url
  const meta = el('p', 'release-meta')
  meta.append(el('span', 'mono', `v${card.version}`), dateNode(card), el('span', 'release-more', '→'))
  a.append(meta, el('h3', '', card.name))
  if (card.summary) a.append(el('p', 'release-summary', firstSentence(card.summary, 160)))
  const counts = countsLine(card.counts)
  if (counts) a.append(el('p', 'release-counts', counts))
  return a
}

function renderReleases(cards, list) {
  const [latest, ...rest] = cards
  const previous = el('div', 'releases-prev')
  previous.append(...rest.slice(0, 3).map(compactCard))
  list.replaceChildren(latestCard(latest), previous)
}

function renderHero(latest) {
  const pillText = document.getElementById('news-pill-text')
  const pill = document.getElementById('news-pill')
  if (pill && pillText) {
    pill.href = latest.url
    pillText.textContent = `New in ${latest.version} — ${firstSentence(latest.summary, 72)}`
  }
  const meta = document.getElementById('hero-meta')
  if (meta) {
    const link = el('a', '', `v${latest.version}`)
    link.href = latest.url
    meta.prepend('Latest ', link, ' · ')
  }
}

function renderQuote(cards) {
  const card = cards.find((c) => c.notProven.length > 0)
  const text = document.getElementById('quote-text')
  const source = document.getElementById('quote-source')
  if (!card || !text || !source) return
  text.textContent = card.notProven[0]
  source.textContent = `— from the Parley ${card.version} release notes`
  source.href = card.url
}

async function loadReleases() {
  const list = document.getElementById('releases-list')
  if (!list) return
  const fallback = [...list.children]
  list.setAttribute('aria-busy', 'true')
  const skeleton = el('div', 'releases-prev')
  list.replaceChildren(el('div', 'card release skeleton'), skeleton)
  skeleton.append(...[0, 1, 2].map(() => el('div', 'card release skeleton')))
  try {
    const response = await fetch('releases.json')
    if (!response.ok) throw new Error(`releases.json: ${response.status}`)
    const picked = pickReleases(await response.json(), 8)
    if (picked.length === 0) throw new Error('releases.json: no published releases')
    const cards = picked.map(toReleaseCard)
    renderReleases(cards.slice(0, 4), list)
    renderHero(cards[0])
    renderQuote(cards)
  } catch {
    list.replaceChildren(...fallback)
  } finally {
    list.removeAttribute('aria-busy')
  }
}
loadReleases()

// Живые макеты.
const roomDemo = document.getElementById('room-demo')
if (roomDemo) initRoom(roomDemo)
const islandDemo = document.getElementById('island-demo')
if (islandDemo) initIsland(islandDemo)

// Copy в шаге установки: ровно текст команды, на 2 с «Copied».
const copyButton = document.querySelector('[data-copy]')
if (copyButton) {
  const source = document.querySelector(copyButton.dataset.copy)
  const status = document.getElementById('copy-status')
  let resetTimer = null
  const copyText = async (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (!ok) throw new Error('copy failed')
  }
  copyButton.addEventListener('click', async () => {
    try {
      await copyText(source.textContent)
    } catch {
      return
    }
    copyButton.textContent = 'Copied'
    if (status) status.textContent = 'Copied'
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copyButton.textContent = 'Copy'
      if (status) status.textContent = ''
    }, 2000)
  })
}
