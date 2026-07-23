// netlify/functions/chatbox-manage-questions.js
//
// The admin panel's Add/Publish/Delete Question actions used to write to
// `chatbox_questions` directly from the browser via the Supabase anon key,
// which meant they were subject to that table's Row Level Security policy —
// and that policy rejects the insert ("new row violates row-level security
// policy"). Rather than changing the RLS policy itself, this function does
// the write server-side with the service-role key (same pattern as
// supabaseAdmin.js elsewhere), after checking the caller has a valid
// Supabase session. RLS only applies to the anon/authenticated keys, so the
// service-role key bypasses it entirely.
//
// Actions: create | bulkCreate | update | delete

const { supabaseAdmin } = require('./_shared/supabaseAdmin');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const MAX_BULK_QUESTIONS = 100;
const VALID_OPTIONS = ['A', 'B', 'C', 'D'];

async function verifyAdmin(accessToken) {
  if (!accessToken) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  return res.ok;
}

function sanitizeQuestion(q) {
  return {
    question_text: String((q && q.question_text) || '').trim(),
    option_a: String((q && q.option_a) || '').trim(),
    option_b: String((q && q.option_b) || '').trim(),
    option_c: String((q && q.option_c) || '').trim(),
    option_d: String((q && q.option_d) || '').trim(),
    correct_option: String((q && q.correct_option) || '').trim().toUpperCase(),
    display_order: Number.isFinite(q && q.display_order) ? q.display_order : (parseInt(q && q.display_order, 10) || 0),
    is_published: false,
  };
}

function validateQuestion(q, label) {
  if (!q.question_text) return `${label} is missing question text.`;
  if (!q.option_a || !q.option_b || !q.option_c || !q.option_d) return `${label} is missing one or more options.`;
  if (!VALID_OPTIONS.includes(q.correct_option)) return `${label} has an invalid correct option (must be A, B, C, or D).`;
  return null;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Supabase credentials are not configured on the server.' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const isAdmin = await verifyAdmin(token);
    if (!isAdmin) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Not authenticated.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    if (action === 'create') {
      const q = sanitizeQuestion(body.question);
      const err = validateQuestion(q, 'This question');
      if (err) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: err }) };

      const { error } = await supabaseAdmin.from('chatbox_questions').insert(q);
      if (error) throw new Error(error.message);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'bulkCreate') {
      const questions = Array.isArray(body.questions) ? body.questions : [];
      if (questions.length === 0) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No questions were provided.' }) };
      }
      if (questions.length > MAX_BULK_QUESTIONS) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `You can add at most ${MAX_BULK_QUESTIONS} questions at once.` }) };
      }

      const rows = [];
      for (let i = 0; i < questions.length; i++) {
        const q = sanitizeQuestion(questions[i]);
        const err = validateQuestion(q, `Question ${i + 1}`);
        if (err) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: err }) };
        rows.push(q);
      }

      const { data, error } = await supabaseAdmin.from('chatbox_questions').insert(rows).select('id');
      if (error) throw new Error(error.message);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, inserted: (data || []).length }) };
    }

    if (action === 'update') {
      const { id, is_published } = body;
      if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'id is required.' }) };

      const { error } = await supabaseAdmin.from('chatbox_questions').update({ is_published: !!is_published }).eq('id', id);
      if (error) throw new Error(error.message);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'id is required.' }) };

      const { error } = await supabaseAdmin.from('chatbox_questions').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
