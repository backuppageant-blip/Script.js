// POST /.netlify/functions/paystack-webhook
// Configure this exact URL in the Paystack Dashboard under
// Settings → API Keys & Webhooks → Webhook URL:
//   https://<your-site>.netlify.app/.netlify/functions/paystack-webhook
// (or your custom domain, e.g. https://mapageantry.online/.netlify/functions/paystack-webhook)
//
// This is the SOURCE OF TRUTH for crediting votes/tickets/brand
// registrations. Unlike verify-vote.js (which only fires if the customer's
// browser stays open long enough to call it after the Paystack popup
// closes), Paystack calls this directly from their servers the moment a
// charge succeeds — so it still fires if the user closes the tab, loses
// signal, or the popup's callback silently fails.
//
// Security: every request must be verified using the HMAC-SHA512 signature
// Paystack sends in the `x-paystack-signature` header, computed over the
// raw request body using your PAYSTACK_SECRET_KEY. Requests that fail this
// check are rejected outright — we never trust an unsigned payload.
const crypto = require('crypto');
const { verifyPaystackTransaction } = require('./_shared/verifyPaystack');
const { processVerifiedPayment } = require('./_shared/creditPayment');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';

  // 1. Verify the signature BEFORE doing anything else with the payload.
  const signature = event.headers['x-paystack-signature'] || event.headers['X-Paystack-Signature'];
  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (!signature || signature !== expectedSignature) {
    console.warn('paystack-webhook: signature mismatch — rejecting request.');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  // 2. We only act on successful charges. Paystack sends many other event
  // types (transfer.success, subscription.create, etc.) — ignore the rest
  // but still return 200 so Paystack doesn't keep retrying them.
  if (payload.event !== 'charge.success') {
    return { statusCode: 200, body: 'Event ignored' };
  }

  const reference = payload.data && payload.data.reference;
  if (!reference) {
    return { statusCode: 400, body: 'Missing reference in payload' };
  }

  // 3. Defense in depth: don't trust amount/metadata straight off the
  // webhook body even though the signature checked out. Re-verify the
  // reference directly against Paystack's API, same as verify-vote.js does.
  const verification = await verifyPaystackTransaction(reference);
  if (!verification.ok) {
    console.error('paystack-webhook: re-verification failed for', reference, verification.message);
    // Return 200 anyway — this is a genuinely failed/invalid transaction,
    // not a delivery problem, so retrying won't help.
    return { statusCode: 200, body: 'Verification failed, no action taken' };
  }

  // 4. Idempotency: processVerifiedPayment() atomically claims this
  // reference (via a unique constraint on transactions.reference) before
  // crediting — verify-vote.js may have already credited this exact
  // reference from the client side, and this makes it safe for both to race.
  try {
    await processVerifiedPayment(verification);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('paystack-webhook: crediting error for', reference, err);
    // 500 tells Paystack to retry the webhook later — appropriate here
    // since this is our own processing failure, not a bad transaction.
    return { statusCode: 500, body: 'Server error while crediting payment' };
  }
};
