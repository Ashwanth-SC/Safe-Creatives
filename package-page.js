const packageConfig = JSON.parse(document.body.dataset.package);
const totalElement = document.querySelector('#package-total');
const saveMessage = document.querySelector('#save-message');
const chosen = { colors: {}, addons: [] };
const saved = JSON.parse(localStorage.getItem(`safeCreativesPackage:${packageConfig.id}`) || 'null');
if (saved) Object.assign(chosen, saved);

function total() { return packageConfig.basePrice + [...document.querySelectorAll('.addon-card.selected')].reduce((sum, addon) => sum + Number(addon.dataset.price), 0); }
function updateTotal() { totalElement.textContent = `₹${total().toLocaleString('en-IN')}`; }
function packageSnapshot() {
  return { packageId:packageConfig.id, basePrice:packageConfig.basePrice, colors:chosen.colors, addons:[...document.querySelectorAll('.addon-card.selected')].map((addon) => ({ id:addon.dataset.id, name:addon.querySelector('h3').textContent, price:Number(addon.dataset.price) })), total:total() };
}
function changeProduct(product, color, button) { const image = product.querySelector('img'); image.src = button.dataset.image; image.alt = `${product.dataset.product} in ${color}`; product.querySelector('[data-spec="finish"]').textContent = button.dataset.finish; product.querySelector('[data-spec="material"]').textContent = button.dataset.material; product.querySelectorAll('.color-option').forEach((item) => item.classList.remove('active')); button.classList.add('active'); chosen.colors[product.dataset.product] = color; }
document.querySelectorAll('.product-block').forEach((product) => { const buttons = product.querySelectorAll('.color-option'); const wantedColor = chosen.colors[product.dataset.product]; const initial = [...buttons].find((button) => button.dataset.color === wantedColor) || buttons[0]; changeProduct(product, initial.dataset.color, initial); buttons.forEach((button) => button.addEventListener('click', () => changeProduct(product, button.dataset.color, button))); });
document.querySelectorAll('.addon-card').forEach((addon) => { const wanted = chosen.addons.includes(addon.dataset.id); const toggle = addon.querySelector('.addon-toggle'); if (wanted) { addon.classList.add('selected'); toggle.textContent = 'Remove'; toggle.classList.add('selected'); } toggle.addEventListener('click', () => { const active = addon.classList.toggle('selected'); toggle.classList.toggle('selected', active); toggle.textContent = active ? 'Remove' : 'Add'; chosen.addons = [...document.querySelectorAll('.addon-card.selected')].map((item) => item.dataset.id); updateTotal(); }); });

function persistPackage(snapshot, append) { localStorage.setItem(`safeCreativesPackage:${packageConfig.id}`, JSON.stringify({ colors:chosen.colors, addons:snapshot.addons.map((addon) => addon.id) })); const result = upsertLocalCartPackage(snapshot, { append }); showSaveToast(result.action === 'updated' ? 'Saved — package updated' : 'Saved — package added to your cart'); }
function showSaveToast(message) { saveMessage.textContent = message; saveMessage.classList.add('is-visible'); window.clearTimeout(showSaveToast.timer); showSaveToast.timer = window.setTimeout(() => saveMessage.classList.remove('is-visible'), 2800); }
function showDuplicatePrompt(snapshot, afterSave) {
  const overlay = document.createElement('div');
  overlay.className = 'cart-confirm-overlay';
  overlay.innerHTML = `<div class="cart-confirm-card" role="dialog" aria-modal="true" aria-labelledby="cart-confirm-title"><p class="eyebrow">PACKAGE ALREADY SAVED</p><h2 id="cart-confirm-title">Add another one?</h2><p>This package was already added into the cart. Would you like to increase the quantity of this package with the currently mentioned add ons?</p><div class="cart-confirm-actions"><button type="button" class="cart-confirm-cancel">Cancel</button><button type="button" class="cart-confirm-save">Save package</button></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.cart-confirm-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.cart-confirm-save').addEventListener('click', () => { persistPackage(snapshot, true); close(); if (afterSave) afterSave(); });
  overlay.querySelector('.cart-confirm-save').focus();
}
function savePackage() { const snapshot = packageSnapshot(); const currentCart = getLocalCarts().find((cart) => cart.userId === getLocalSession()?.id && cart.status === 'active'); if (currentCart?.packages?.some((item) => item.packageId === snapshot.packageId)) { showDuplicatePrompt(snapshot); return; } persistPackage(snapshot, false); }
function showReviewPrompt() {
  const overlay = document.createElement('div');
  overlay.className = 'cart-confirm-overlay';
  overlay.innerHTML = `<div class="cart-confirm-card" role="dialog" aria-modal="true" aria-labelledby="review-confirm-title"><p class="eyebrow">REVIEW YOUR PACKAGE</p><h2 id="review-confirm-title">Save your changes?</h2><p>Would you like to save this package to your cart before continuing to the review page?</p><div class="cart-confirm-actions"><button type="button" class="cart-confirm-cancel">Continue with review</button><button type="button" class="cart-confirm-save">Save to cart</button></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.cart-confirm-cancel').addEventListener('click', () => { close(); window.location.href = 'checkout.html'; });
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.cart-confirm-save').addEventListener('click', () => { close(); savePackage(); });
  overlay.querySelector('.cart-confirm-save').focus();
}
document.querySelector('#save-package').addEventListener('click', savePackage);
document.querySelector('#review-order').addEventListener('click', showReviewPrompt);
updateTotal();
