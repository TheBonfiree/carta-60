/* ---------------------------------------------------------------------------
 * form.js — early-access capture
 *
 * Where the data goes:
 *   The form POSTs to the site's own origin. Netlify's edge matches the
 *   `form-name` field against the forms it found by parsing the deployed HTML,
 *   swallows the request before it reaches the static site, stores the fields
 *   with its own timestamp, and fires a notification email. No third-party
 *   origin is contacted and there is no key in this file to leak.
 *
 * Why submit is intercepted at all:
 *   A native POST works — and is the no-JS fallback — but it navigates away to
 *   Netlify's generic success page, dropping the visitor out of a page whose
 *   whole argument is continuity. fetch() keeps them here and lets the success
 *   copy be ours.
 *
 * Validation is ours rather than the browser's, so the messages sit in the
 * page's own type, in the right place, instead of in a native bubble that
 * looks like no other element on the site. `novalidate` is set from JS rather
 * than in the markup, so a no-JS visitor keeps the browser's checks instead of
 * losing validation entirely.
 * ------------------------------------------------------------------------- */

import { FORM } from './config.js';

/* Deliberately loose. Anything stricter starts rejecting addresses that are
 * perfectly valid (new TLDs, plus-addressing, quoted locals) and the only real
 * proof of an address is mail arriving at it. This catches typos and
 * `notanemail`, which is all a client-side check can honestly claim. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES = {
  name: 'Please tell us your name.',
  email: 'Please enter an email address.',
  emailFormat: "That doesn't look like an email address.",
  message: "Please tell us what you're looking for.",
};

/** Field wrapper for a control, plus its error slot. */
function parts(control) {
  const field = control.closest('.field');
  return { field, error: field?.querySelector('[data-field-error]') };
}

function setError(control, message) {
  const { field, error } = parts(control);
  if (!field) return;
  field.classList.add('is-invalid');
  control.setAttribute('aria-invalid', 'true');
  if (error) error.textContent = message;
}

function clearError(control) {
  const { field, error } = parts(control);
  if (!field) return;
  field.classList.remove('is-invalid');
  control.removeAttribute('aria-invalid');
  if (error) error.textContent = '';
}

/**
 * Validate every required control, marking each failure.
 * Returns the first invalid control, or null when the form is good.
 */
function validate(form) {
  const controls = [form.elements.name, form.elements.email, form.elements.message];
  let first = null;

  controls.forEach((control) => {
    const value = control.value.trim();
    let message = '';

    if (!value) {
      message = MESSAGES[control.name];
    } else if (control.name === 'email' && !EMAIL.test(value)) {
      message = MESSAGES.emailFormat;
    }

    if (message) {
      setError(control, message);
      if (!first) first = control;
    } else {
      clearError(control);
    }
  });

  return first;
}

/**
 * Swap the form out for the thank-you, and move focus so it is announced.
 *
 * The closing CTA goes too: it exists to drive people to this form, and once
 * they have used it, repeating the ask is noise pointing at a form that is no
 * longer there.
 */
function succeed(form, done) {
  form.hidden = true;
  done.hidden = false;
  document.querySelector('[data-closer]')?.setAttribute('hidden', '');
  done.querySelector('[data-form-done-head]')?.focus();
}

export function initForm() {
  const form = document.querySelector('[data-access-form]');
  if (!form) return;

  const done = document.querySelector('[data-form-done]');
  const button = form.querySelector('[data-form-submit]');
  const status = form.querySelector('[data-form-status]');
  const label = button.textContent;

  // Suppress native validation HERE rather than with a novalidate attribute in
  // the markup: our messages sit in the page's own type, in the right place,
  // instead of in a native bubble that looks like no other element on the site
  // — but a visitor without JS gets the browser's checks rather than none.
  form.noValidate = true;

  // Stop a field nagging while it is being corrected — the error clears as
  // soon as the visitor touches it, not on the next submit.
  form.querySelectorAll('input, textarea').forEach((control) => {
    control.addEventListener('input', () => {
      if (control.closest('.field')?.classList.contains('is-invalid')) clearError(control);
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    status.classList.remove('is-error');

    const invalid = validate(form);
    if (invalid) {
      invalid.focus();
      return;
    }

    // Disabling is what actually prevents a double submission; the label
    // change is just so the disabled state reads as progress, not as refusal.
    button.disabled = true;
    button.textContent = 'Sending…';

    try {
      if (FORM.devEcho) {
        succeed(form, done);
        return;
      }

      // Two independent captures run per submit. The visitor is told it worked
      // if EITHER lands, so one pipeline being down never loses a lead silently
      // nor blocks the confirmation.
      let captured = false;

      // PRIMARY — Netlify Forms. Stores the submission and sends the email.
      // FormData already carries the hidden form-name and the honeypot, so
      // nothing is hand-assembled.
      try {
        const res = await fetch(FORM.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)).toString(),
        });
        if (res.ok) captured = true;
        else console.error(`Netlify Forms POST failed: ${res.status}`);
      } catch (err) {
        console.error('Netlify Forms POST threw', err);
      }

      // SECONDARY — Airtable via the serverless function. Non-blocking: a
      // failure is logged here (and in the function's Netlify logs) but must
      // never throw out of this handler or undo a successful primary capture.
      try {
        const res = await fetch(FORM.airtableEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.elements.name.value.trim(),
            email: form.elements.email.value.trim(),
            message: form.elements.message.value.trim(),
          }),
        });
        if (res.ok) captured = true;
        else console.error(`Airtable pipeline failed: ${res.status}`);
      } catch (err) {
        console.error('Airtable pipeline threw', err);
      }

      if (!captured) throw new Error('Both capture paths failed');
      succeed(form, done);
    } catch (err) {
      // Never fail silently, and never discard what was typed — the values
      // stay in the fields so a retry costs nothing.
      console.error(err);
      button.disabled = false;
      button.textContent = label;
      status.textContent =
        "That didn't send — check your connection and try again.";
      status.classList.add('is-error');
    }
  });
}
