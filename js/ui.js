/* ---------------------------------------------------------------------------
 * ui.js — nav rail state and the pill controls
 *
 * Nothing here reads layout during scroll: section tracking is delegated to
 * ScrollTrigger, which batches its own measurement.
 * ------------------------------------------------------------------------- */

/**
 * Highlight the nav-rail item matching the section in view, in both scroll
 * directions.
 */
function initNavRail() {
  const links = Array.from(document.querySelectorAll('[data-nav-link]'));
  if (!links.length) return;

  const setActive = (id) => {
    links.forEach((a) => {
      const on = a.getAttribute('href') === `#${id}`;
      a.classList.toggle('is-active', on);
      // Announce state rather than relying on colour alone.
      a.setAttribute('aria-current', on ? 'true' : 'false');
    });
  };

  links.forEach((link) => {
    const id = link.getAttribute('href').slice(1);
    const section = document.getElementById(id);
    if (!section) return;

    ScrollTrigger.create({
      trigger: section,
      start: 'top 50%',
      end: 'bottom 50%',
      onToggle: (self) => self.isActive && setActive(id),
    });
  });

  setActive(links[0].getAttribute('href').slice(1));

  // Smooth anchor scrolling, unless the visitor asked for less motion.
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  links.forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = document.getElementById(link.getAttribute('href').slice(1));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  });
}

/**
 * Pill controls.
 *
 * "Access" is the page's single call to action and appears twice — hero and
 * closer — both routed here to the one form. "Explore" is navigation to the
 * assembly section, kept visually quieter so it does not read as a second ask.
 *
 * NOTE: the "Configure" pill was removed with the early-access work. It was an
 * affordance with no configurator behind it, sitting next to the page's only
 * real conversion point. Wiring a real one still needs a second frame set (an
 * alternate colourway) — see README.
 */
function initPills() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior = reduce ? 'auto' : 'smooth';

  document.querySelectorAll('[data-pill]').forEach((pill) => {
    pill.addEventListener('click', () => {
      const action = pill.dataset.pill;

      if (action === 'explore') {
        document.getElementById('inside')?.scrollIntoView({ behavior });
        return;
      }

      if (action === 'access') {
        const section = document.getElementById('access');
        if (!section) return;
        section.scrollIntoView({ behavior });
        // Focus the first field so the CTA lands the visitor IN the form, not
        // merely near it. Deferred past the smooth scroll: focusing during it
        // makes the browser jump to the element and cancel the animation.
        const first = document.getElementById('f-name');
        if (!first) return;
        if (reduce) first.focus();
        else setTimeout(() => first.focus({ preventScroll: true }), 700);
      }
    });
  });
}

/** Slow drift on the hero still — the only motion before first scroll. */
function initHeroDrift() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('[data-hero-media]')?.classList.add('is-drifting');
}

export function initUI() {
  initNavRail();
  initPills();
  initHeroDrift();
}
