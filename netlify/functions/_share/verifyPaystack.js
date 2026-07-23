// Confirms a transaction reference actually succeeded, straight from
// Paystack's servers — never trust amount/status/metadata sent by the browser.
// Requires PAYSTACK_SECRET_KEY set in Netlify env vars (the sk_live_... key,
// not the pk_live_... public key already in index.html).
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

async function verifyPaystackTransaction(reference) {
  if (!reference) {
    return { ok: false, message: 'Missing transaction reference.' };
  }

  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const json = await res.json();

  if (!res.ok || !json.status || !json.data) {
    return { ok: false, message: json.message || 'Could not verify transaction with Paystack.' };
  }

  const data = json.data;
  if (data.status !== 'success') {
    return { ok: false, message: `Transaction status: ${data.status}` };
  }

  return {
    ok: true,
    amountKobo: data.amount,
    amountNGN: data.amount / 100,
    email: data.customer ? data.customer.email : null,
    metadata: data.metadata || {},
    reference: data.reference,
  };
}

module.exports = { verifyPaystackTransaction };
