const form = document.querySelector('#enquiry-form');
const steps = [...document.querySelectorAll('.form-step')];
const message = document.querySelector('#form-message');
let currentStep = 0;

function showStep(index) {
  steps.forEach((step, i) => step.classList.toggle('active', i === index));
  currentStep = index;
  message.textContent = '';
}

document.querySelectorAll('.form-next').forEach((button) => button.addEventListener('click', () => {
  const fields = [...steps[currentStep].querySelectorAll('input, select')];
  if (!fields.every((field) => field.reportValidity())) return;
  showStep(Math.min(currentStep + 1, steps.length - 1));
}));
document.querySelectorAll('.form-prev').forEach((button) => button.addEventListener('click', () => showStep(Math.max(currentStep - 1, 0))));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('.form-submit');
  submit.disabled = true;
  submit.textContent = 'Sending…';

  const fd = new FormData(form);
  const body = {
    full_name: fd.get('full_name'),
    phone: fd.get('phone'),
    email: fd.get('email'),
    pin_code: fd.get('pin_code'),
    area_sqft: fd.get('area_sqft'),
    project_category: fd.get('project_category'),
    requirement: fd.get('requirement'),
    // Honeypot: empty for a real person; the Edge Function drops it if set.
    botcheck: Boolean(fd.get('botcheck')),
  };

  try {
    // Saves the lead into the Turnkey dashboard and emails all admins.
    const { data, error } = await sb.functions.invoke('submit-turnkey-lead', { body });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    form.reset();
    steps.forEach((step, i) => step.classList.toggle('active', i === 0));
    currentStep = 0;
    message.textContent = 'Thanks for reaching out, our representatives will get in touch with you shortly.';
    message.className = 'form-message success';
  } catch (error) {
    // Surface the real cause in the console — a 404 means the Edge Function
    // isn't deployed yet; the function's own message (from error.context) tells
    // you if it's a validation or database problem.
    console.error('Turnkey enquiry submission failed:', error);
    try {
      const detail = await error?.context?.clone?.().json?.();
      if (detail?.error) console.error('Function said:', detail.error);
    } catch (_ignored) { /* response had no JSON body */ }
    message.textContent = 'Something went wrong while sending your enquiry. Please try again.';
    message.className = 'form-message error';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Submit enquiry ↗︎';
  }
});

// ---------------------------------------------------------------------------
// Gallery preview — the first 4 published turnkey_gallery projects, with a
// "View more" button to the full gallery. The section stays hidden if there
// are no published projects (or on error).
// ---------------------------------------------------------------------------
(function () {
  const section = document.getElementById('tk-gallery');
  const grid = document.getElementById('tk-gallery-grid');
  if (!section || !grid || typeof sb === 'undefined') return;
  const photoUrl = (path) => sb.storage.from('turnkey-gallery').getPublicUrl(path).data.publicUrl;

  (async () => {
    let items = [];
    try {
      const { data, error } = await sb
        .from('turnkey_gallery')
        .select('id, title, category, location, cover_photo')
        .eq('published', true)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      items = data || [];
    } catch (e) {
      return; // leave the section hidden
    }
    if (!items.length) return;

    grid.textContent = '';
    items.forEach((it) => {
      const a = document.createElement('a');
      a.className = 'tk-gcard';
      a.href = 'gallery.html';
      const media = document.createElement('div');
      media.className = 'tk-gcard-media';
      if (it.cover_photo) {
        const img = document.createElement('img');
        img.src = photoUrl(it.cover_photo);
        img.alt = it.title || 'Project';
        img.loading = 'lazy';
        media.appendChild(img);
      }
      const body = document.createElement('div');
      body.className = 'tk-gcard-body';
      if (it.category) {
        const cat = document.createElement('span');
        cat.className = 'tk-gcard-cat';
        cat.textContent = it.category;
        body.appendChild(cat);
      }
      const h = document.createElement('h3');
      h.className = 'tk-gcard-title';
      h.textContent = it.title || 'Untitled';
      body.appendChild(h);
      if (it.location) {
        const loc = document.createElement('span');
        loc.className = 'tk-gcard-loc';
        loc.textContent = it.location;
        body.appendChild(loc);
      }
      a.append(media, body);
      grid.appendChild(a);
    });
    section.hidden = false;
  })();
})();
