const profile = getLocalProfile();
const session = getLocalSession();
const activeCart = getLocalCarts().find((cart) => cart.userId === session?.id && cart.status === 'active');
const profileDetails = document.querySelector('#profile-details');
const cartPackages = document.querySelector('#cart-packages');

function money(value) { return `₹${Number(value || 0).toLocaleString('en-IN')}`; }
function addDetail(label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value || 'Not provided';
  row.append(term, description);
  profileDetails.appendChild(row);
}

addDetail('Full name', profile?.fullName);
addDetail('Email', profile?.email);
addDetail('Phone number', profile?.phone);
addDetail('Address', profile?.address);

const packages = activeCart?.packages || [];
if (!packages.length) {
  document.querySelector('#cart-empty').hidden = false;
} else {
  packages.forEach((item, packageIndex) => {
    const card = document.createElement('article');
    card.className = 'review-package';
    const title = document.createElement('h3');
    title.textContent = item.packageId === 'living-room' ? 'Living room package' : 'Bedroom package';
    const selections = document.createElement('div');
    selections.className = 'review-selections';
    const colourTitle = document.createElement('p');
    colourTitle.textContent = 'Main product colours';
    selections.appendChild(colourTitle);
    const colourList = document.createElement('ul');
    Object.entries(item.colors || {}).forEach(([product, colour]) => { const row = document.createElement('li'); row.textContent = `${product}: ${colour}`; colourList.appendChild(row); });
    selections.appendChild(colourList);
    const addonTitle = document.createElement('p');
    addonTitle.textContent = 'Add-ons';
    selections.appendChild(addonTitle);
    const addonList = document.createElement('ul');
    if (item.addons?.length) item.addons.forEach((addon) => { const row = document.createElement('li'); row.textContent = `${addon.name} — ${money(addon.price)}`; addonList.appendChild(row); });
    else { const row = document.createElement('li'); row.textContent = 'No add-ons selected'; addonList.appendChild(row); }
    selections.appendChild(addonList);
    const footer = document.createElement('div');
    footer.className = 'review-package-footer';
    const edit = document.createElement('a');
    edit.href = item.packageId === 'living-room' ? 'living-room-package.html' : 'bedroom-package.html';
    edit.textContent = 'Edit package';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-package';
    remove.textContent = 'Remove package';
    remove.addEventListener('click', () => confirmRemove(item, packageIndex));
    const total = document.createElement('strong');
    total.textContent = money(item.total);
    const footerActions = document.createElement('div');
    footerActions.className = 'review-package-actions';
    footerActions.append(edit, remove);
    footer.append(footerActions, total);
    card.append(title, selections, footer);
    cartPackages.appendChild(card);
  });
}
document.querySelector('#cart-total').textContent = money(packages.reduce((sum, item) => sum + Number(item.total || 0), 0));

function confirmRemove(item, packageIndex) {
  const overlay = document.createElement('div');
  overlay.className = 'cart-confirm-overlay';
  overlay.innerHTML = '<div class="cart-confirm-card" role="dialog" aria-modal="true" aria-labelledby="remove-confirm-title"><p class="eyebrow">REMOVE PACKAGE</p><h2 id="remove-confirm-title">Are you sure?</h2><p>This package will be removed from your cart. You can add it again later from the Sensory Rooms page.</p><div class="cart-confirm-actions"><button type="button" class="cart-confirm-cancel">Cancel</button><button type="button" class="cart-confirm-save">Remove package</button></div></div>';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.cart-confirm-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.cart-confirm-save').addEventListener('click', () => {
    const carts = getLocalCarts();
    const index = carts.findIndex((cart) => cart.id === activeCart?.id);
    if (index >= 0) {
      carts[index].packages = carts[index].packages.filter((stored, storedIndex) => stored.cartItemId ? stored.cartItemId !== item.cartItemId : storedIndex !== packageIndex);
      carts[index].updatedAt = new Date().toISOString();
      saveLocalCarts(carts);
    }
    close();
    window.location.reload();
  });
  overlay.querySelector('.cart-confirm-cancel').focus();
}
