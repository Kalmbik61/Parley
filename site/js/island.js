// Остров в секции острова (§8): четыре состояния по кругу, между ними капсула.
// Без JS и с reduced motion виден раскрытый остров в состоянии 1; точки переключают без анимации.

const DWELL = 4500 // сколько показано состояние
const CAPSULE = 600 // сколько между состояниями стоит капсула
const COLLAPSE = 300 // сворачивание без перелёта

export function initIsland(screen) {
  const isl = screen.querySelector('.isl')
  const panels = [...screen.querySelectorAll('.isl-panel')]
  const demo = screen.closest('.island-demo')
  const dots = [...demo.querySelectorAll('.island-dots button')]
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
  const reduce = () => mql.matches

  screen.classList.add('live')
  let heights = []
  let current = 0

  // Высоту экрана считаем по самому высокому состоянию, чтобы страница не прыгала.
  function measure() {
    screen.classList.add('measuring')
    heights = panels.map((_, i) => {
      panels.forEach((p, j) => (p.hidden = j !== i))
      return isl.offsetHeight
    })
    panels.forEach((p, j) => (p.hidden = j !== current))
    screen.classList.remove('measuring')
    screen.style.setProperty('--sh', `${30 + Math.max(...heights) + 48}px`)
    isl.style.setProperty('--h', `${heights[current]}px`)
  }

  function apply(i) {
    current = i
    panels.forEach((p, j) => (p.hidden = j !== i))
    isl.style.setProperty('--h', `${heights[i]}px`)
    isl.setAttribute('aria-label', panels[i].dataset.label)
    dots.forEach((d, j) => {
      if (j === i) d.setAttribute('aria-current', 'true')
      else d.removeAttribute('aria-current')
    })
  }

  // --- таймер с паузой: наведение, фокус и уход с экрана ставят цикл на паузу ---
  let timer = null
  let job = null // { fn, left, at }
  const holds = new Set()
  const run = () => {
    if (!job || timer || holds.size) return
    job.at = Date.now()
    timer = setTimeout(() => {
      const { fn } = job
      timer = null
      job = null
      fn()
    }, job.left)
  }
  const schedule = (fn, ms) => {
    clear()
    job = { fn, left: ms, at: 0 }
    run()
  }
  function clear() {
    clearTimeout(timer)
    timer = null
    job = null
  }
  const hold = (key, on) => {
    if (on) {
      holds.add(key)
      if (timer && job) {
        clearTimeout(timer)
        timer = null
        job.left -= Date.now() - job.at
      }
    } else {
      holds.delete(key)
      run()
    }
  }

  let token = 0
  let moveTimer = null // переход между состояниями не зависит от паузы: ставится на паузу только ожидание
  function show(i, { instant = false } = {}) {
    const mine = ++token
    clear()
    clearTimeout(moveTimer)
    if (instant || reduce()) {
      isl.classList.add('open')
      apply(i)
      return
    }
    const open = () => {
      if (mine !== token) return
      apply(i)
      isl.classList.add('open')
      schedule(() => show((i + 1) % panels.length), DWELL)
    }
    if (!isl.classList.contains('open')) {
      open()
      return
    }
    isl.classList.remove('open') // сворачиваемся в капсулу
    moveTimer = setTimeout(open, COLLAPSE + CAPSULE)
  }

  function start() {
    measure()
    apply(0)
    isl.classList.add('open')
    if (!reduce()) schedule(() => show(1), DWELL)
  }

  dots.forEach((dot, i) =>
    dot.addEventListener('click', () => {
      if (i === current && isl.classList.contains('open')) return
      show(i)
    })
  )
  demo.addEventListener('pointerenter', () => hold('hover', true))
  demo.addEventListener('pointerleave', () => hold('hover', false))
  demo.addEventListener('focusin', () => hold('focus', true))
  demo.addEventListener('focusout', () => hold('focus', false))

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => hold('offscreen', !entries[entries.length - 1].isIntersecting), {
      threshold: 0.2,
    }).observe(demo)
  }

  let resizeTimer = null
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(measure, 150)
  })

  const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
  ready.then(start)
}
