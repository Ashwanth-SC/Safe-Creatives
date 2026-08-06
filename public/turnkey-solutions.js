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
