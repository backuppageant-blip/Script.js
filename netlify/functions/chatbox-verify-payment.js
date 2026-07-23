// POST /.netlify/functions/chatbox-verify-payment
// Body: { reference, fullName, email, whatsappNumber }
// Verifies the ₦300 entry payment, then creates (or reuses) the chatbox
// registration and returns its id for the client to store locally.
const { supabaseAdmin } = require('./_shared/supabaseAdmin');
const { verifyPaystackTransaction } = require('./_shared/verifyPaystack');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  let reference, fullName, email, whatsappNumber;
  try {
    ({ reference, fullName, email, whatsappNumber } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid request body.' }) };
  }

  if (!fullName || !email) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Full name and email are required.' }) };
  }

  const verification = await verifyPaystackTransaction(reference);
  if (!verification.ok) {
    return { statusCode: 402, body: JSON.stringify({ success: false, message: verification.message }) };
  }

  if (verification.amountNGN < 300) {
    return { statusCode: 402, body: JSON.stringify({ success: false, message: 'Amount paid is below the ₦300 entry fee.' }) };
  }

  // Idempotency: if this reference was already used, return the existing
  // registration. This SELECT-then-INSERT has a race window (two requests
  // for the same reference could both miss the SELECT), so the INSERT
  // below also has to handle a duplicate-key error as the fallback path —
  // relies on a UNIQUE constraint on chatbox_registrations.reference.
  const { data: existing } = await supabaseAdmin
    .from('chatbox_registrations')
    .select('id, access_token')
    .eq('reference', verification.reference)
    .maybeSingle();

  if (existing) {
    return { statusCode: 200, body: JSON.stringify({ success: true, registrationId: existing.id, accessToken: existing.access_token }) };
  }

  const { data: created, error } = await supabaseAdmin
    .from('chatbox_registrations')
    .insert({
      full_name: fullName,
      email,
      whatsapp_number: whatsappNumber || null,
      paid: true,
      reference: verification.reference,
    })
    .select('id, access_token')
    .single();

  if (error) {
    // 23505 = unique_violation — a concurrent request for this same
    // reference won the race and inserted first. Not an error: fetch and
    // return that registration instead of failing the request.
    if (error.code === '23505') {
      const { data: winner } = await supabaseAdmin
        .from('chatbox_registrations')
        .select('id, access_token')
        .eq('reference', verification.reference)
        .maybeSingle();
      if (winner) {
        return { statusCode: 200, body: JSON.stringify({ success: true, registrationId: winner.id, accessToken: winner.access_token }) };
      }
    }
    console.error('chatbox-verify-payment insert error:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Could not create registration.' }) };
  }

  await supabaseAdmin.from('transactions').insert({
    email,
    amount: verification.amountNGN,
    reference: verification.reference,
    type: 'chatbox_registration',
  });

  return { statusCode: 200, body: JSON.stringify({ success: true, registrationId: created.id, accessToken: created.access_token }) };
};
