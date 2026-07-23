// netlify/functions/b2-set-cors.js
//
// ONE-TIME SETUP UTILITY — not part of the app's normal runtime.
//
// The B2 web console's "Share everything... with this one origin" CORS
// wizard only covers read/download operations. It does not reliably enable
// b2_upload_file / b2_upload_part, which is what a direct browser upload
// (what b2-sign-upload.js issues tokens for) actually needs — hence
// uploads keep failing with "Failed to fetch" even after setting CORS
// through the console. This calls B2's b2_update_bucket API directly with
// an explicit corsRules list that includes the upload operations.
//
// Usage: while logged into the admin panel (so you have a Supabase session),
// visit this URL once in the browser (or curl it with an Authorization
// header): POST /.netlify/functions/b2-set-cors
// Then delete this file / remove it from the repo — it doesn't need to
// exist for the app to run day-to-day.
//
// Requires the same B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY env vars as
// b2-sign-upload.js. NOTE: if that application key was created narrowly
// scoped just for uploading/reading files, it may lack the "writeBuckets"
// capability this needs — if you get an "unauthorized" error back, you'll
// need to run this once with your account's master application key
// (temporarily swap B2_APPLICATION_KEY_ID/KEY in Netlify, run this, then
// swap back to the restricted key).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const B2_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
const B2_APP_KEY = process.env.B2_APPLICATION_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

const SITE_ORIGIN = 'https://mapageantry.online';

async function verifyAdmin(accessToken) {
  if (!accessToken) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
  });
  return res.ok;
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
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const isAdmin = await verifyAdmin(token);
    if (!isAdmin) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Not authenticated.' }) };
    }

    if (!B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET_NAME) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'B2 credentials are not configured on the server.' }) };
    }

    const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      headers: { Authorization: 'Basic ' + Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64') },
    });
    if (!authRes.ok) throw new Error(`B2 authorize failed: ${authRes.status} ${await authRes.text()}`);
    const auth = await authRes.json();

    const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
      method: 'POST',
      headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: auth.accountId, bucketName: B2_BUCKET_NAME }),
    });
    if (!listRes.ok) throw new Error(`B2 list buckets failed: ${listRes.status} ${await listRes.text()}`);
    const listData = await listRes.json();
    const bucket = (listData.buckets || [])[0];
    if (!bucket) throw new Error(`B2 bucket "${B2_BUCKET_NAME}" not found for this key.`);

    const corsRules = [
      {
        corsRuleName: 'browserDirectUpload',
        allowedOrigins: [SITE_ORIGIN],
        allowedOperations: [
          'b2_upload_file',
          'b2_upload_part',
          'b2_download_file_by_name',
          'b2_download_file_by_id',
          's3_put',
          's3_get',
          's3_head',
        ],
        allowedHeaders: ['*'],
        exposeHeaders: ['x-bz-content-sha1', 'x-bz-file-name'],
        maxAgeSeconds: 3600,
      },
    ];

    const updateRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_update_bucket`, {
      method: 'POST',
      headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: auth.accountId,
        bucketId: bucket.bucketId,
        corsRules,
      }),
    });
    const updateData = await updateRes.json();
    if (!updateRes.ok) {
      throw new Error(`b2_update_bucket failed: ${updateRes.status} ${JSON.stringify(updateData)}`);
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, corsRules: updateData.corsRules }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
