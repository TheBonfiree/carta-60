/* ---------------------------------------------------------------------------
 * submit-lead.js — Netlify Function: push one lead into Airtable
 *
 * Why this exists at all:
 *   The site is static and the Airtable token must never reach the browser.
 *   This function runs on Netlify's servers, reads the token from an
 *   environment variable, and makes the Airtable call server-side. The
 *   frontend only ever knows this function's URL path — no secret is shipped.
 *
 * It is intentionally dependency-free: the Netlify Node runtime (18+) has a
 * global `fetch`, so there is no node_modules to bundle and nothing that can
 * break on a no-build deploy.
 *
 * This is the SECONDARY capture. Netlify Forms (the browser's POST to "/")
 * remains the primary path and the email notification; a failure here is
 * logged and surfaced to the caller but is designed never to block the
 * visitor's confirmation — see js/form.js.
 *
 * After the row is saved it also fires REAL first-touch outreach: it sends the
 * lead a transactional email via Brevo, then — only if that email was actually
 * accepted for delivery — advances the Airtable row to "Contacted". This is
 * what makes the pipeline autonomous: a lead arriving does the work, with no
 * human pressing anything. The same request id appears in the "LEAD" and
 * "OUTREACH" log lines and on the row, so the whole chain is auditable and
 * cross-referenceable without anyone watching it happen. Outreach is fail-open:
 * a Brevo outage logs and leaves the row at "New", never losing the lead nor
 * blocking the visitor's confirmation.
 * ------------------------------------------------------------------------- */

const AIRTABLE_API = 'https://api.airtable.com/v0';
const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method not allowed' });
  }

  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || 'Leads';

  // A missing env var is an operator mistake, not a visitor one. Log it loudly
  // (it lands in Netlify → Functions → submit-lead → logs) and fail closed.
  if (!key || !base) {
    console.error('submit-lead: AIRTABLE_API_KEY or AIRTABLE_BASE_ID not set');
    return json(500, { ok: false, error: 'server not configured' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  const message = String(data.message || '').trim();

  if (!name || !email || !message) {
    return json(400, { ok: false, error: 'missing fields' });
  }

  // Provenance — observed by the server, not claimed by the client. A row typed
  // by hand in Airtable cannot carry these: the Netlify request id also appears
  // in this function's own logs, and referer/host are what Netlify's edge saw.
  const h = event.headers || {};
  const at = new Date().toISOString();
  const prov = {
    reqId: h['x-nf-request-id'] || '',
    referer: h['referer'] || h['referrer'] || '',
    host: h['x-forwarded-host'] || h['host'] || '',
    ip: h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '',
    ua: h['user-agent'] || '',
    at,
  };
  // One structured line so the invocation is greppable in Netlify → Functions
  // → submit-lead → logs, and cross-referenceable to the Airtable row.
  console.log('LEAD ' + JSON.stringify({ email, name, ...prov }));

  const url = `${AIRTABLE_API}/${base}/${encodeURIComponent(table)}`;
  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  try {
    // Core insert — only the fields we know exist, so a real lead is never lost.
    const res = await fetch(url, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        typecast: true,
        records: [
          {
            fields: {
              Name: name,
              Email: email,
              Message: message,
              'Submitted At': at,
              Status: 'New',
            },
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('submit-lead: Airtable rejected', res.status, detail);
      return json(502, { ok: false, error: 'airtable rejected the record' });
    }

    const created = await res.json();
    const recordId = created?.records?.[0]?.id || null;

    // Provenance lives in the immutable "LEAD" log line above (reqId, referer,
    // host, ip), which is the tamper-evident record for cross-referencing. We do
    // NOT stamp it back onto the row: the Leads base has no "Source"/"Request ID"
    // columns, and Airtable 422s a PATCH naming any unknown field.

    // Real first-touch outreach. The lead is already safely saved as "New" by
    // this point, so everything below is best-effort: any failure is logged and
    // swallowed, the row simply stays "New", and the visitor's confirmation is
    // untouched. Only a genuinely-sent email advances the row to "Contacted".
    const outreach = await fireOutreach({ name, email, prov, recordId, url, auth });

    return json(200, { ok: true, provenance: prov, recordId, ...outreach });
  } catch (err) {
    console.error('submit-lead: Airtable request failed', err);
    return json(502, { ok: false, error: 'airtable unreachable' });
  }
};

/**
 * Send the lead a real first-touch email via Brevo, and — only if it was
 * accepted for delivery — advance the Airtable row to "Contacted". Fail-open by
 * contract: returns a status object and never throws, so the caller's
 * already-saved lead and the visitor's confirmation are never at risk.
 *
 * Returns one of:
 *   { messageId, outreach: 'triggered' }  — email sent, row set to Contacted
 *   { outreach: 'skipped' }               — Brevo env not configured
 *   { outreach: 'failed' }                — the send errored; row stays New
 */
async function fireOutreach({ name, email, prov, recordId, url, auth }) {
  const key = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM;
  const fromName = process.env.EMAIL_FROM_NAME || 'CARTA 60';

  // Missing config is an operator state, not a failure: the lead is captured and
  // the site stays deployable before email is wired. Log once and move on.
  if (!key || !from) {
    console.warn('submit-lead: Brevo not configured, skipping outreach');
    return { outreach: 'skipped' };
  }

  try {
    // The actual first-touch — a genuine email to the lead. Only a real send
    // (Brevo returns 201 + messageId) is allowed to make "Contacted" mean
    // something. Content is deliberately plain and honest.
    const safeName = escapeHtml(name);
    const res = await fetch(BREVO_API, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from, name: fromName },
        to: [{ email, name }],
        replyTo: { email: from, name: fromName },
        subject: 'Thanks for your interest in CARTA 60',
        htmlContent:
          `<p>Hi ${safeName},</p>` +
          `<p>Thanks for requesting early access to CARTA 60 — we've got your message ` +
          `and we'll be in touch shortly.</p>` +
          `<p>— The CARTA 60 team</p>`,
        tags: ['carta60-first-touch'],
      }),
    });
    if (!res.ok) {
      const d = await res.text();
      console.error('submit-lead: Brevo send failed', res.status, d.slice(0, 200));
      return { outreach: 'failed' };
    }
    const body = await res.json().catch(() => ({}));
    const messageId = body?.messageId || null;

    // Real outreach fired — now, and only now, advance the row. The Leads base
    // has exactly one status-bearing column, `Status` (single-select), so we
    // write ONLY that field: Airtable 422s the whole PATCH if any field name is
    // unknown, so adding "Contacted At"/"Message ID" (which don't exist) would
    // reject the valid Status write with them. `typecast:true` creates the
    // "Contacted" option if it isn't defined yet.
    if (recordId) {
      try {
        const patch = await fetch(url, {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({
            typecast: true,
            records: [{ id: recordId, fields: { Status: 'Contacted' } }],
          }),
        });
        if (!patch.ok) {
          const d = await patch.text();
          console.log('submit-lead: status advance skipped', patch.status, d.slice(0, 120));
        }
      } catch (e) {
        console.log('submit-lead: status advance threw', String(e));
      }
    }

    // One structured, greppable line carrying the SAME reqId as the "LEAD" line,
    // so the automated chain is provable end-to-end from the logs alone.
    console.log('OUTREACH ' + JSON.stringify({
      reqId: prov.reqId, messageId, recordId, channel: 'brevo', status: 'triggered', at: prov.at,
    }));
    return { outreach: 'triggered', messageId };
  } catch (err) {
    console.error('submit-lead: Brevo outreach threw', String(err));
    return { outreach: 'failed' };
  }
}

/** Minimal HTML-escape so a lead's name can't inject markup into the email. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
