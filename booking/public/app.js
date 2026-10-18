// Booking page: fetches open slots (UTC) and renders them in the visitor's timezone.
(() => {
  const app = document.getElementById('app');
  const token = app.dataset.token;
  const locale = app.dataset.locale || 'pt-BR';
  const $ = (id) => document.getElementById(id);
  const tzSelect = $('tz');
  const status = $('status');
  const daysEl = $('days');
  const timesEl = $('times');
  const form = $('form');

  let slots = [];
  let duration = 30;
  let tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let selectedDay = null;

  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [tz];
  if (!zones.includes(tz)) zones.unshift(tz);
  tzSelect.innerHTML = zones.map((z) => `<option${z === tz ? ' selected' : ''}>${z}</option>`).join('');
  tzSelect.addEventListener('change', () => { tz = tzSelect.value; selectedDay = null; render(); });

  const fmt = (ms, opts) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(ms));
  const dayKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms)); // YYYY-MM-DD
  const hm = { hour: '2-digit', minute: '2-digit' };

  function button(label, onClick, active) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = label;
    if (active) b.className = 'active';
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    form.hidden = true;
    daysEl.hidden = timesEl.hidden = false;
    daysEl.replaceChildren();
    timesEl.replaceChildren();
    if (!slots.length) return;

    const byDay = new Map();
    for (const s of slots) {
      const k = dayKey(s);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(s);
    }
    if (!selectedDay || !byDay.has(selectedDay)) selectedDay = byDay.keys().next().value;

    for (const [k, list] of byDay) {
      const label = `<span>${fmt(list[0], { weekday: 'short' })}</span><strong>${fmt(list[0], { day: 'numeric' })}</strong><span>${fmt(list[0], { month: 'short' })}</span>`;
      daysEl.append(button(label, () => { selectedDay = k; render(); }, k === selectedDay));
    }
    for (const s of byDay.get(selectedDay)) timesEl.append(button(fmt(s, hm), () => choose(s)));
  }

  function choose(start) {
    form.elements.start.value = new Date(start).toISOString();
    form.elements.tz.value = tz;
    $('chosen').textContent =
      `${fmt(start, { weekday: 'long', day: 'numeric', month: 'long' })}, ${fmt(start, hm)} – ${fmt(start + duration * 60000, hm)} (${tz})`;
    daysEl.hidden = timesEl.hidden = true;
    form.hidden = false;
    (form.elements.name || form.querySelector('button[type=submit]')).focus();
  }

  $('back').addEventListener('click', render);
  form.addEventListener('submit', () => { form.querySelector('button[type=submit]').disabled = true; });

  fetch(`/api/slots${token ? `?token=${encodeURIComponent(token)}` : ''}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      slots = data.slots;
      duration = data.durationMinutes;
      status.textContent = slots.length ? '' : 'Nenhum horário disponível nos próximos dias.';
      status.hidden = slots.length > 0;
      render();
    })
    .catch((err) => { status.textContent = err.message || 'Não foi possível carregar os horários.'; status.className = 'error'; });
})();
