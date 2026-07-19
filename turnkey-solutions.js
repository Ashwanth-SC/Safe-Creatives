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
  if (form.querySelector('[name="access_key"]').value === 'YOUR_WEB3FORMS_ACCESS_KEY') {
    message.textContent = 'Add your Web3Forms access key in turnkey-solutions.html to enable submissions.';
    message.className = 'form-message error';
    submit.disabled = false;
    submit.textContent = 'Submit enquiry ↗';
    return;
  }
  try {
    const response = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Submission failed');
    form.reset();
    steps.forEach((step, i) => step.classList.toggle('active', i === 0));
    message.textContent = 'Thanks for reaching out, our representatives will get in touch with you shortly.';
    message.className = 'form-message success';
  } catch (error) {
    message.textContent = 'Something went wrong while sending your enquiry. Please try again.';
    message.className = 'form-message error';
  } finally { submit.disabled = false; submit.textContent = 'Submit enquiry ↗'; }
});
