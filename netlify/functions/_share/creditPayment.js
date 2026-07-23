// Shared crediting logic for a successfully-verified Paystack transaction.
// Used by BOTH verify-vote.js (client-triggered, right after the popup
// closes) and paystack-webhook.js (server-to-server, triggered by Paystack
// itself). Keeping this in one place means both paths can never drift out
// of sync with each other.
//
// IMPORTANT: `verification` here is always the *already-verified* result of
// verifyPaystackTransaction() — i.e. amount/metadata/email that came back
// from Paystack's own API, never anything read directly off the client.
const { supabaseAdmin } = require('./supabaseAdmin');

async function creditPayment(verification) {
  const { type } = verification.metadata;

  if (type === 'vote') {
    await handleVote(verification);
  } else if (type === 'ticket') {
    await handleTicket(verification);
  } else if (type === 'brand_registration') {
    await handleBrandRegistration(verification);
  } else if (type === 'chatbox_registration') {
    // chatbox registration is created directly by chatbox-verify-payment.js
    // (it needs fullName/email/whatsapp from the client, which a bare
    // webhook payload doesn't carry) — nothing further to credit here.
    return;
  } else if (type === 'modeling_registration') {
    await handleModelingRegistration(verification);
  } else if (type === 'ambassador_registration') {
    await handleAmbassadorRegistration(verification);
  } else {
    throw new Error(`Unknown payment type: ${type}`);
  }
}

async function handleVote(verification) {
  const { contestantId, voteCountToCredit } = verification.metadata;
  const voteCount = parseInt(voteCountToCredit, 10);

  if (!contestantId || !voteCount || voteCount < 1) {
    throw new Error('Invalid vote metadata.');
  }

  // Cross-check what was actually paid against the current vote price —
  // stops a tampered client from claiming more votes than it paid for.
  const { data: config } = await supabaseAdmin
    .from('system_configuration')
    .select('vote_price_cost')
    .eq('id', 1)
    .single();

  const pricePerVote = (config && config.vote_price_cost) || 250;
  const expectedNGN = voteCount * pricePerVote;

  if (verification.amountNGN < expectedNGN) {
    throw new Error(`Amount paid (₦${verification.amountNGN}) does not cover ${voteCount} votes at ₦${pricePerVote} each.`);
  }

  const { error } = await supabaseAdmin.rpc('increment_contestant_votes', {
    row_id: contestantId,
    increment_by: voteCount,
  });
  if (error) throw error;
}

async function handleTicket(verification) {
  // No dedicated tickets table yet — this just records the sale in
  // `transactions` (already done by the caller) for manual fulfilment.
  // If ticket volume grows, add a `tickets` table + door-list export here.
  return;
}

async function handleBrandRegistration(verification) {
  const { brandName } = verification.metadata;
  const { data: config } = await supabaseAdmin
    .from('system_configuration')
    .select('registration_fee')
    .eq('id', 1)
    .single();

  const expectedNGN = (config && config.registration_fee) || 20000;
  if (verification.amountNGN < expectedNGN) {
    throw new Error(`Amount paid (₦${verification.amountNGN}) is below the ₦${expectedNGN} registration fee.`);
  }

  // paid stays false until an admin fills in category/description/image and
  // flips it live — matches the "our team will add your storefront card" copy.
  const { error } = await supabaseAdmin.from('marketplace_brands').insert({
    brand_name: brandName,
    paid: false,
  });
  if (error) throw error;
}

async function handleModelingRegistration(verification) {
  const { data: config } = await supabaseAdmin
    .from('system_configuration')
    .select('modeling_registration_fee')
    .eq('id', 1)
    .single();

  const expectedNGN = (config && config.modeling_registration_fee) || 5000;
  if (verification.amountNGN < expectedNGN) {
    throw new Error(`Amount paid (₦${verification.amountNGN}) is below the ₦${expectedNGN} modeling registration fee.`);
  }

  // No insert here — the registrant record is created client-side by
  // onVerified() once this resolves successfully (same pattern as
  // chatbox_registration). This just guards against amount tampering.
}

async function handleAmbassadorRegistration(verification) {
  const { data: config } = await supabaseAdmin
    .from('system_configuration')
    .select('ambassador_registration_fee')
    .eq('id', 1)
    .single();

  const expectedNGN = (config && config.ambassador_registration_fee) || 15000;
  if (verification.amountNGN < expectedNGN) {
    throw new Error(`Amount paid (₦${verification.amountNGN}) is below the ₦${expectedNGN} ambassador registration fee.`);
  }

  // No insert here — the registrant record is created client-side by
  // onVerified() once this resolves successfully (same pattern as
  // chatbox_registration). This just guards against amount tampering.
}

// Atomically claims a transaction reference and credits it. Both
// verify-vote.js (client-triggered) and paystack-webhook.js (server-triggered)
// call this instead of doing their own "SELECT then INSERT" idempotency
// check — that pattern was NOT actually race-safe: two requests for the
// same reference (client + webhook) could both pass the SELECT before
// either finished the INSERT, and both would call creditPayment(),
// double-crediting votes/tickets/registrations.
//
// This version inserts the transactions row FIRST, before crediting
// anything. The insert is atomic at the database level, so it acts as a
// mutex: only one caller can win it. This REQUIRES a UNIQUE constraint on
// transactions.reference — without it, this fix has no effect and the
// race condition still exists. If crediting then fails, the claim is
// released (the row is deleted) so a retry (e.g. Paystack's webhook retry)
// can safely attempt it again.
async function processVerifiedPayment(verification) {
  const { error: insertError } = await supabaseAdmin.from('transactions').insert({
    email: verification.email,
    amount: verification.amountNGN,
    reference: verification.reference,
    type: verification.metadata.type,
  });

  if (insertError) {
    // 23505 = unique_violation — another request already claimed (and is
    // crediting, or has credited) this exact reference. Not an error.
    if (insertError.code === '23505') {
      return { alreadyProcessed: true };
    }
    throw insertError;
  }

  try {
    await creditPayment(verification);
  } catch (err) {
    // Crediting failed after we claimed the reference — release the claim
    // so this reference isn't stuck "processed" with nothing actually credited.
    await supabaseAdmin.from('transactions').delete().eq('reference', verification.reference);
    throw err;
  }

  return { alreadyProcessed: false };
}

module.exports = { creditPayment, processVerifiedPayment };
