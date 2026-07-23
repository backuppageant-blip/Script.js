// POST /.netlify/functions/chatbox-send-message
// Body: { accessToken, message }
// Posts a message into the shared live feed. Runs server-side so only paid,
// registered entrants can post — the table's public insert policy is wide
// open at the DB level, but going through this function lets us validate
// registration and trim/limit content before it lands in the feed.
//
// Auth: the client used to send its bare `registrationId`, which is a
// guessable/sequential id — anyone could send it and post messages as any
// entrant. It now sends `accessToken`, a random per-registration secret
// (see required-db-migration.sql) that only the real registrant ever
// receives, so this lookup doubles as authentication.
const { supabaseAdmin } = require('./_shared/supabaseAdmin');

const MAX_MESSAGE_LENGTH = 300;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  let accessToken, message;
  try {
    ({ accessToken, message } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid request body.' }) };
  }

  const trimmed = (message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!accessToken || !trimmed) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Missing registration or message.' }) };
  }

  const { data: registration } = await supabaseAdmin
    .from('chatbox_registrations')
    .select('id, full_name, paid')
    .eq('access_token', accessToken)
    .maybeSingle();

  if (!registration || !registration.paid) {
    return { statusCode: 403, body: JSON.stringify({ success: false, message: 'No active chatbox registration found.' }) };
  }

  const { error } = await supabaseAdmin.from('chatbox_messages').insert({
    registration_id: registration.id,
    sender_name: registration.full_name,
    message: trimmed,
    is_system_message: false,
  });

  if (error) {
    console.error('chatbox-send-message insert error:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Could not send message.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
