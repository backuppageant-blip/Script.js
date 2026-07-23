// POST /.netlify/functions/chatbox-submit-answer
// Body: { accessToken, questionId, submittedOption }
// Grades the answer server-side (correct_option never reaches the browser),
// tracks the running correct count, and — first entrant to reach 10 correct
// answers — atomically claims the win.
//
// Auth: the client used to send its bare `registrationId`, which is a
// guessable/sequential id — anyone could send someone else's id and submit
// answers (or claim the win) on their behalf. It now sends `accessToken`,
// a random per-registration secret (see required-db-migration.sql) that
// only the real registrant ever receives, so this lookup doubles as
// authentication. The registration's internal `id` (from this lookup) is
// used for all subsequent DB writes — it's never taken from the client.
const { supabaseAdmin } = require('./_shared/supabaseAdmin');

const WINNING_CORRECT_COUNT = 10;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
  }

  let accessToken, questionId, submittedOption;
  try {
    ({ accessToken, questionId, submittedOption } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid request body.' }) };
  }

  if (!accessToken || !questionId || !submittedOption) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Missing required fields.' }) };
  }

  if (!['A', 'B', 'C', 'D'].includes(String(submittedOption).toUpperCase())) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'submittedOption must be A, B, C, or D.' }) };
  }

  // The round timer is otherwise only enforced client-side — check it here
  // too so answers can't be submitted by calling this function directly
  // before the round starts, after it ends, or while the contest is stopped.
  const { data: contestState } = await supabaseAdmin
    .from('chatbox_contest_state')
    .select('is_active, started_at, round_duration_seconds')
    .eq('id', 1)
    .maybeSingle();

  if (!contestState || !contestState.is_active || !contestState.started_at) {
    return { statusCode: 403, body: JSON.stringify({ success: false, message: 'The contest round is not currently active.' }) };
  }

  const roundDurationMs = (Number(contestState.round_duration_seconds) || 120) * 1000;
  const roundEndsAt = new Date(contestState.started_at).getTime() + roundDurationMs;
  if (Date.now() > roundEndsAt) {
    return { statusCode: 403, body: JSON.stringify({ success: false, message: 'This round has ended.' }) };
  }

  const { data: registration } = await supabaseAdmin
    .from('chatbox_registrations')
    .select('id, paid')
    .eq('access_token', accessToken)
    .maybeSingle();

  if (!registration || !registration.paid) {
    return { statusCode: 403, body: JSON.stringify({ success: false, message: 'No active chatbox registration found.' }) };
  }

  const registrationId = registration.id;

  const { data: question } = await supabaseAdmin
    .from('chatbox_questions')
    .select('id, correct_option, is_published')
    .eq('id', questionId)
    .maybeSingle();

  if (!question || !question.is_published) {
    return { statusCode: 404, body: JSON.stringify({ success: false, message: 'Question not available.' }) };
  }

  const isCorrect = String(submittedOption).toUpperCase() === String(question.correct_option).toUpperCase();

  const { error: insertError } = await supabaseAdmin.from('chatbox_answers').insert({
    registration_id: registrationId,
    question_id: questionId,
    submitted_option: submittedOption,
    is_correct: isCorrect,
  });

  if (insertError) {
    // 23505 = unique_violation — this registration already answered this question
    if (insertError.code === '23505') {
      return { statusCode: 200, body: JSON.stringify({ success: false, message: 'You already answered this question.' }) };
    }
    console.error('chatbox-submit-answer insert error:', insertError);
    return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Could not record answer.' }) };
  }

  const { count: correctCount } = await supabaseAdmin
    .from('chatbox_answers')
    .select('id', { count: 'exact', head: true })
    .eq('registration_id', registrationId)
    .eq('is_correct', true);

  let isWinner = false;

  if (correctCount >= WINNING_CORRECT_COUNT) {
    // Atomic claim: only succeeds for whichever request gets here first while
    // winner_registration_id is still null, preventing a tie from both
    // requests declaring themselves the winner.
    const { data: claimed } = await supabaseAdmin
      .from('chatbox_contest_state')
      .update({ winner_registration_id: registrationId, is_active: false })
      .eq('id', 1)
      .is('winner_registration_id', null)
      .select('winner_registration_id')
      .maybeSingle();

    isWinner = !!claimed;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, isCorrect, correctCount, isWinner }),
  };
};
