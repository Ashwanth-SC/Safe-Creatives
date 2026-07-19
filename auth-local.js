const LOCAL_USERS_KEY = "safeCreativesUsers";
const LOCAL_SESSION_KEY = "safeCreativesSession";
const LOCAL_CARTS_KEY = "safeCreativesCarts";

function getLocalUsers() { return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "[]"); }
function saveLocalUsers(users) { localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users)); }
function getLocalSession() { return JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) || "null"); }
function createLocalSession(user) { localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ id:user.id, email:user.email, fullName:user.fullName })); }
function isLoggedIn() { return Boolean(getLocalSession()); }
function requireLocalLogin(nextPage) { if (!isLoggedIn()) { window.location.href = `login.html?next=${encodeURIComponent(nextPage)}`; return false; } return true; }

function getLocalCarts() { return JSON.parse(localStorage.getItem(LOCAL_CARTS_KEY) || "[]"); }
function saveLocalCarts(carts) { localStorage.setItem(LOCAL_CARTS_KEY, JSON.stringify(carts)); }
function getLocalProfile() { const session = getLocalSession(); return session ? getLocalUsers().find((user) => user.id === session.id) || null : null; }
function upsertLocalCartPackage(packageData, options = {}) {
  const session = getLocalSession();
  if (!session) throw new Error("Please login before saving a package.");
  const carts = getLocalCarts();
  let cart = carts.find((item) => item.userId === session.id && item.status === "active");
  if (!cart) { cart = { id:crypto.randomUUID(), userId:session.id, status:"active", packages:[], updatedAt:new Date().toISOString() }; carts.push(cart); }
  const packageIndex = options.append ? -1 : cart.packages.findIndex((item) => item.packageId === packageData.packageId);
  const storedPackage = { ...packageData, cartItemId:packageData.cartItemId || crypto.randomUUID(), updatedAt:new Date().toISOString() };
  if (packageIndex >= 0) cart.packages[packageIndex] = storedPackage;
  else cart.packages.push(storedPackage);
  cart.updatedAt = new Date().toISOString();
  saveLocalCarts(carts);
  return { cart, action:packageIndex >= 0 ? "updated" : "added" };
}

document.querySelectorAll("[data-auth-required]").forEach((link) => link.addEventListener("click", (event) => { if (!requireLocalLogin(link.dataset.authRequired)) event.preventDefault(); }));
if (document.body.dataset.requiresAuth === "true") requireLocalLogin(window.location.pathname.split("/").pop() || "sensory-rooms.html");

function logOutLocal() {
  localStorage.removeItem(LOCAL_SESSION_KEY);
  window.location.href = "index.html";
}

function accountIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M4.5 20c.5-4 3.4-6.5 7.5-6.5s7 2.5 7.5 6.5"></path></svg>';
}

function setUpAccountMenu() {
  let trigger = document.querySelector(".account-link");
  let container = trigger?.parentElement;
  if (!trigger) {
    container = document.querySelector(".site-header") || document.querySelector(".package-topbar") || document.body;
    trigger = document.createElement("a");
    trigger.className = "account-link auth-generated";
    trigger.href = "login.html";
    trigger.setAttribute("aria-label", "Open account menu");
    trigger.innerHTML = accountIcon();
    container.appendChild(trigger);
  }
  const dropdown = document.createElement("div");
  dropdown.className = "account-dropdown";
  dropdown.hidden = true;
  dropdown.innerHTML = '<span class="account-status"></span><button type="button" class="logout-button">Log out</button>';
  container.appendChild(dropdown);
  const session = getLocalSession();
  if (session) {
    dropdown.querySelector(".account-status").textContent = session.fullName || session.email;
    trigger.addEventListener("click", (event) => { event.preventDefault(); dropdown.hidden = !dropdown.hidden; });
    dropdown.querySelector(".logout-button").addEventListener("click", logOutLocal);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setUpAccountMenu);
else setUpAccountMenu();

if (isLoggedIn()) {
  let inactivityTimer;
  const resetInactivityTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(logOutLocal, 10 * 60 * 1000);
  };
  ["pointerdown", "mousemove", "keydown", "scroll", "touchstart"].forEach((eventName) => window.addEventListener(eventName, resetInactivityTimer, { passive: true }));
  resetInactivityTimer();
}
