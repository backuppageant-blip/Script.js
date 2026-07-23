// POST /.netlify/functions/verify-vote
// Body: { reference }
// Client-triggered verification, called right after the Paystack popup
// reports success. This is a *convenience* path for instant UI feedback —
// paystack-webhook.js is the source of truth and will credit the same
// transaction even if the user closes their browser before this runs.
// Metadata and amount are read from Paystack's own response, not trusted
// from the browser — the only thing the client sends us is the reference.
const { verifyPaystackTransaction } = require('./_shared/verifyPaystack');
const { processVerifiedPayment } = require('./_shared/creditPayment');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  let reference;
  try {
    ({ reference } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid request body.' }) };
  }

  const verification = await verifyPaystackTransaction(reference);
  if (!verification.ok) {
    return { statusCode: 402, body: JSON.stringify({ success: false, message: verification.message }) };
  }

  // Idempotency: processVerifiedPayment() atomically claims this reference
  // (via a unique constraint on transactions.reference) before crediting,
  // so it's safe for this endpoint AND the webhook to race on the same
  // reference — whichever gets here first wins, the other becomes a no-op.
  try {
    const { alreadyProcessed } = await processVerifiedPayment(verification);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: alreadyProcessed ? 'Already processed.' : undefined }),
    };
  } catch (err) {
    console.error('verify-vote processing error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Server error while crediting payment.' }) };
  }
};
