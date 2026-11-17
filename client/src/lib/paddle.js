/**
 * Paddle.js (Paddle Billing v2), loaded on demand from Paddle's CDN only when someone starts a checkout.
 * The server decides plan, price and quantity (POST /api/billing/checkout); the plan activates from Paddle's webhook,
 * never from this page.
 */
const SRC = 'https://cdn.paddle.com/paddle/v2/paddle.js';
let loading = null;
let initialized = null; // "environment|token" Paddle was initialized with

function load() {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error('Paddle checkout did not load')));
      s.onerror = () => { loading = null; reject(new Error('Could not load Paddle checkout. Check your connection or ad blocker, then try again.')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * Open Paddle's checkout overlay. `checkout` = { environment, clientToken, items, customer, customData, successUrl }.
 * `onClose` runs when the buyer closes it without paying.
 */
export async function openPaddleCheckout(checkout, { onClose } = {}) {
  const Paddle = await load();
  const key = `${checkout.environment}|${checkout.clientToken}`;
  if (initialized !== key) {
    if (checkout.environment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({
      token: checkout.clientToken,
      eventCallback: (e) => { if (e?.name === 'checkout.closed') onClose?.(); },
    });
    initialized = key;
  }
  Paddle.Checkout.open({
    items: checkout.items,
    customer: checkout.customer,
    customData: checkout.customData,
    // One-page: email, card and the Apple Pay / Google Pay buttons on one screen (fewer steps than multi-page).
    settings: { displayMode: 'overlay', variant: 'one-page', successUrl: checkout.successUrl, allowLogout: false, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light' },
  });
}
