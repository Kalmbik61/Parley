// Живая комната в hero (§7): сценарий, карточка решения, Accept, Return for rework, Replay.
// Разметка по умолчанию уже показывает состояние t = 11.0, поэтому без JS это статичная картинка.
// Весь текст кладётся через textContent.

const PROMPT = 'Add partial refunds to refund.ts. Agree on the rules first, then split the work.'
const DECISION =
  'Refunds above the captured amount fail with RefundTooLarge; partial refunds stay in the capture currency. Split: @S02 backend — refund.ts and a unit test, @S03 review — the diff, @S04 tests — e2e.'
const NOTE = 'Also cap the sum of all partial refunds.'

const AGENTS = {
  s1: { n: 1, name: 'S01 architect', lead: true, av: 'av-claude' },
  s2: { n: 2, name: 'S02 backend', av: 'av-claude' },
  s3: { n: 3, name: 'S03 review', av: 'av-codex' },
  s4: { n: 4, name: 'S04 tests', av: 'av-glm' },
}
const STATES = {
  idle: { word: 'idle', dot: 'st-idle' },
  working: { word: 'working', dot: 'st-work' },
  need: { word: 'needs you', dot: 'st-need' },
  done: { word: 'done', dot: 'st-done' },
}

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Текст с чипами упоминаний: `@S02 backend` → span.mention. */
function richText(parent, text) {
  text.split(/(@S0\d \w+)/).forEach((part) => {
    if (!part) return
    parent.append(/^@S0\d /.test(part) ? el('span', 'mention', part) : part)
  })
  return parent
}

export function initRoom(room) {
  const feed = room.querySelector('#room-feed')
  const input = room.querySelector('.composer-input')
  const send = room.querySelector('.composer .btn-primary')
  const replay = room.querySelector('.room-replay')
  const sideWord = room.querySelector('#side-decision')
  const chips = Object.fromEntries(
    [...room.querySelectorAll('.members [data-agent]')].map((n) => [n.dataset.agent, n])
  )
  const rows = Object.fromEntries(
    [...room.querySelectorAll('.side-sessions [data-agent]')].map((n) => [n.dataset.agent, n])
  )
  const typing = el('p', 'typing')
  typing.setAttribute('aria-hidden', 'true')
  typing.append(el('span'), el('i'), el('i'), el('i'))
  feed.after(typing)

  const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
  const reduce = () => mql.matches

  // --- таймеры: Replay отменяет всё, что ещё не сработало ---
  const timers = new Set()
  const later = (ms, fn) => {
    const id = setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
  }
  const cancelAll = () => {
    timers.forEach(clearTimeout)
    timers.clear()
  }

  // --- вид ---
  const scrollFeed = () =>
    feed.scrollTo({ top: feed.scrollHeight, behavior: reduce() ? 'auto' : 'smooth' })

  function setState(id, key) {
    const s = STATES[key]
    for (const node of [chips[id], rows[id]]) {
      if (!node) continue
      const dot = node.querySelector('.st')
      dot.className = `st ${s.dot}`
      node.querySelector('.chip-state, .side-state').textContent = s.word
    }
    chips[id].classList.toggle('chip-need', key === 'need')
  }
  const setAll = (key) => Object.keys(AGENTS).forEach((id) => setState(id, key))

  function showTyping(name) {
    typing.firstChild.textContent = `${name} is writing…`
    typing.classList.add('on')
  }
  const hideTyping = () => typing.classList.remove('on')

  function addMsg({ who, text, tag }) {
    const art = el('article', 'msg msg-in')
    const body = el('div', 'msg-body')
    const head = el('p', 'msg-head')
    if (who === 'you') {
      art.append(el('span', 'av av-you', 'Y'))
      head.append(el('b', '', 'You'))
    } else {
      const a = AGENTS[who]
      art.append(el('span', `av ${a.av}`, String(a.n)))
      head.append(el('b', '', a.name))
      if (a.lead) head.append(el('span', 'lead-star', '★'))
    }
    head.append(el('span', 'to', '→ all'))
    if (tag) head.append(el('span', `tag tag-${tag}`, tag))
    body.append(head, richText(el('p', 'msg-text'), text))
    art.firstChild.setAttribute('aria-hidden', 'true')
    art.append(body)
    feed.append(art)
    scrollFeed()
    return art
  }

  function showDecisionWord(on) {
    if (sideWord) sideWord.hidden = !on
  }

  // --- карточка решения (§7.3) ---
  function addDecision(text) {
    const card = el('div', 'decision msg-in')
    const head = el('p', 'decision-head')
    const av = el('span', 'av av-claude', '1')
    av.setAttribute('aria-hidden', 'true')
    head.append(av, el('b', '', 'S01 architect'), el('span', 'tag tag-question', 'decision · waiting for you'), el('span', 'now', 'now'))
    const body = richText(el('p', 'decision-text'), text)
    const actions = el('p', 'decision-actions')
    const accept = el('button', 'btn btn-primary btn-sm', 'Accept')
    accept.type = 'button'
    const rework = el('button', 'btn btn-secondary btn-sm', 'Return for rework')
    rework.type = 'button'
    actions.append(accept, rework)
    card.append(head, body, actions)
    feed.append(card)
    scrollFeed()
    if (!reduce()) accept.classList.add('pulse')
    showDecisionWord(true)

    accept.addEventListener('click', () => onAccept(card, actions))
    rework.addEventListener('click', () => onRework(card, actions, accept, rework))
    return accept
  }

  function onAccept(card, actions) {
    if (card.dataset.settled) return
    card.dataset.settled = 'accepted'
    // Решение принято: тег и рамка карточки меняют цвет терракоты на шалфей.
    const tag = card.querySelector('.decision-head .tag')
    tag.className = 'tag tag-decision'
    tag.textContent = 'decision · accepted'
    card.classList.add('decision--accepted')
    const hadFocus = card.contains(document.activeElement)
    const done = el('span', 'accepted', '✓ You accepted this decision')
    done.tabIndex = -1
    actions.replaceChildren(done)
    // Кнопка исчезла: возвращаем фокус на подтверждение, иначе клавиатура теряет место.
    if (hadFocus) done.focus({ preventScroll: true })
    showDecisionWord(false)
    const decision = '@S02 backend — refund.ts and a unit test. @S03 review — the diff. @S04 tests — e2e.'
    const note =
      'refund.ts is done: RefundTooLarge above the captured amount, unit test green. @S03 review, the diff is yours.'
    const step1 = () => {
      hideTyping()
      addMsg({ who: 's1', text: decision, tag: 'decision' })
      setState('s2', 'working')
      setState('s4', 'working')
    }
    const step2 = () => {
      hideTyping()
      addMsg({ who: 's2', text: note, tag: 'note' })
      setState('s2', 'done')
      setState('s3', 'working')
      replay.hidden = false
    }
    if (reduce()) {
      step1()
      step2()
      return
    }
    showTyping(AGENTS.s1.name)
    later(600, step1)
    later(600 + 2400, () => showTyping(AGENTS.s2.name))
    later(600 + 3000, step2)
  }

  function onRework(card, actions, accept, rework) {
    if (card.dataset.settled) return
    const field = el('textarea', 'note-field')
    field.rows = 2
    field.name = 'rework-note'
    field.placeholder = 'What should the lead change?'
    field.setAttribute('aria-label', 'What should the lead change?')
    const row = el('p', 'decision-actions')
    const sendBtn = el('button', 'btn btn-primary btn-sm', 'Send to lead')
    sendBtn.type = 'button'
    const cancel = el('button', 'btn btn-secondary btn-sm', 'Cancel')
    cancel.type = 'button'
    row.append(sendBtn, cancel)
    actions.replaceChildren(field, row)
    scrollFeed()

    // Печатаем заметку сами, пока посетитель не начал писать свою.
    let touched = false
    field.addEventListener('keydown', () => {
      touched = true
    })
    if (reduce()) field.value = NOTE
    else {
      let i = 0
      const tick = () => {
        if (touched || i >= NOTE.length) return
        i += 1
        field.value = NOTE.slice(0, i)
        later(28, tick)
      }
      tick()
    }
    field.focus({ preventScroll: true })

    cancel.addEventListener('click', () => {
      touched = true
      actions.replaceChildren(accept, rework)
      rework.focus({ preventScroll: true })
    })
    sendBtn.addEventListener('click', () => {
      if (card.dataset.settled) return
      const text = field.value.trim()
      if (!text) {
        field.focus({ preventScroll: true })
        return
      }
      touched = true
      card.dataset.settled = 'returned'
      showDecisionWord(false)
      const hadFocus = card.contains(document.activeElement)
      const line = el('p', 'returned-line msg-in', `↩ Returned for rework: «${text}»`)
      card.replaceWith(line)
      setState('s1', 'working')
      const again = () => {
        hideTyping()
        const next = addDecision(`Version 2, with your note. ${DECISION}`)
        setState('s1', 'idle')
        if (hadFocus || document.activeElement === document.body) next.focus({ preventScroll: true })
      }
      if (reduce()) again()
      else {
        showTyping(AGENTS.s1.name)
        later(1200, again)
      }
    })
  }

  // --- сценарий (§7.2) ---
  function reset() {
    cancelAll()
    feed.replaceChildren()
    hideTyping()
    input.value = ''
    send.classList.remove('is-pressed')
    replay.hidden = true
    setAll('idle')
    showDecisionWord(false)
  }

  const sendPrompt = () => {
    input.value = ''
    send.classList.add('is-pressed')
    later(300, () => send.classList.remove('is-pressed'))
    addMsg({ who: 'you', text: PROMPT })
    setAll('working')
  }

  function showFinal() {
    addMsg({ who: 'you', text: PROMPT })
    addMsg({
      who: 's1',
      tag: 'question',
      text: 'Should partial refunds be capped by the captured amount? @S02 backend, what does refund.ts do today?',
    })
    const replies = [
      ['s2', 'Today it only checks the order total. I\'d reject anything above the captured amount with RefundTooLarge and keep the capture currency.'],
      ['s3', 'Agreed. Add a test for multi-currency captures — that\'s where it broke last time.'],
      ['s4', 'I\'ll cover it end-to-end: capture in EUR, refund in two parts, then a third one that must fail.'],
    ]
    for (const [who, text] of replies) addMsg({ who, text, tag: 'note' })
    setAll('idle')
    addDecision(DECISION)
  }

  function play() {
    reset()
    feed.setAttribute('aria-live', 'polite')
    if (reduce()) {
      showFinal()
      return
    }
    for (let i = 1; i <= PROMPT.length; i += 1) later(i * 28, () => (input.value = PROMPT.slice(0, i)))
    later(2800, sendPrompt)
    later(4200, () => showTyping(AGENTS.s1.name))
    later(5000, () => {
      hideTyping()
      addMsg({
        who: 's1',
        tag: 'question',
        text: 'Should partial refunds be capped by the captured amount? @S02 backend, what does refund.ts do today?',
      })
    })
    const replies = [
      [6600, 's2', "Today it only checks the order total. I'd reject anything above the captured amount with RefundTooLarge and keep the capture currency."],
      [8000, 's3', "Agreed. Add a test for multi-currency captures — that's where it broke last time."],
      [9400, 's4', "I'll cover it end-to-end: capture in EUR, refund in two parts, then a third one that must fail."],
    ]
    for (const [t, who, text] of replies) {
      later(t - 600, () => showTyping(AGENTS[who].name))
      later(t, () => {
        hideTyping()
        addMsg({ who, text, tag: 'note' })
        setState(who, 'idle')
      })
    }
    later(10400, () => showTyping(AGENTS.s1.name))
    later(11000, () => {
      hideTyping()
      addDecision(DECISION)
      setState('s1', 'idle')
    })
  }

  replay.addEventListener('click', play)

  // Окно мок-апа: пока оно не на экране, показываем пустую комнату; сценарий стартует один раз.
  room.classList.add('room--live')
  reset()
  feed.setAttribute('aria-live', 'off')
  if (reduce()) {
    play()
  } else if (!('IntersectionObserver' in window)) {
    play()
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1]
        const big = e.intersectionRect.height >= window.innerHeight * 0.5
        if (!e.isIntersecting || (e.intersectionRatio < 0.35 && !big)) return
        io.disconnect()
        play()
      },
      { threshold: [0, 0.35, 0.6, 1] }
    )
    io.observe(room)
  }
}
