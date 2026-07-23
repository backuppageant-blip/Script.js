// netlify/functions/b2-sign-upload.js
//
// Issues a short-lived, single-use Backblaze B2 upload URL so the admin
// panel can upload images directly from the browser instead of pasting
// URLs. The B2 application key never reaches the browser.
//
// Required Netlify environment variables (Site settings → Environment variables):
//   B2_APPLICATION_KEY_ID
//   B2_APPLICATION_KEY
//   B2_BUCKET_NAME   (e.g. "mapageantry-media")
//
// Auth model: any signed-in Supabase user is treated as admin, so for
// admin-managed folders (contestants, brands, gallery, etc.) this function
// verifies the caller's Supabase access token before handing out a B2
// upload token.
//
// EXCEPTION: registrant self-service photo uploads (Model/Ambassador
// registration) happen before the person has any account, so they can't
// carry a Supabase auth token. Those are only allowed to target the
// PUBLIC_UPLOAD_FOLDERS below, are exempt from the auth check, and are
// capped in size/type — everything else still requires admin auth.
//
// SUPABASE_URL / SUPABASE_ANON_KEY are read from env instead of being
// hardcoded here — the anon key isn't secret, but hardcoding it created a
// second copy that could silently drift from the real value (e.g. after a
// key rotation) since Netlify already has both set for the other functions.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const B2_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
const B2_APP_KEY = process.env.B2_APPLICATION_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

// Folders a non-admin (unauthenticated registrant) is allowed to upload
// into. Keep this list tight — anything not listed here still requires
// admin auth.
const PUBLIC_UPLOAD_FOLDERS = ['registrants'];
const MAX_PUBLIC_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_PUBLIC_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Cached across warm invocations of the same function instance.
let b2Cache = null; // { authToken, apiUrl, downloadUrl, bucketId, expiresAt }

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  return res.ok;
}

async function authorizeB2() {
  if (b2Cache && b2Cache.expiresAt > Date.now()) return b2Cache;

  const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64'),
    },
  });
  if (!authRes.ok) {
    throw new Error(`B2 authorize failed: ${authRes.status} ${await authRes.text()}`);
  }
  const auth = await authRes.json();

  const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ accountId: auth.accountId, bucketName: B2_BUCKET_NAME }),
  });
  if (!listRes.ok) {
    throw new Error(`B2 list buckets failed: ${listRes.status} ${await listRes.text()}`);
  }
  const listData = await listRes.json();
  const bucket = (listData.buckets || [])[0];
  if (!bucket) throw new Error(`B2 bucket "${B2_BUCKET_NAME}" not found for this key.`);

  b2Cache = {
    authToken: auth.authorizationToken,
    apiUrl: auth.apiUrl,
    downloadUrl: auth.downloadUrl,
    bucketId: bucket.bucketId,
    expiresAt: Date.now() + 1000 * 60 * 60 * 20, // B2 tokens last ~24h; refresh a bit early
  };
  return b2Cache;
}

function sanitizeSegment(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    if (!B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET_NAME) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'B2 credentials are not configured on the server.' }) };
    }

    const { fileName, folder, fileSize, contentType } = JSON.parse(event.body || '{}');
    if (!fileName) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'fileName is required.' }) };
    }

    const isPublicRegistrationUpload = PUBLIC_UPLOAD_FOLDERS.includes(folder);

    if (isPublicRegistrationUpload) {
      // Registrant self-service upload — no Supabase account exists yet,
      // so skip auth, but enforce type/size limits since this path is
      // otherwise open to anyone.
      if (!contentType || !ALLOWED_PUBLIC_CONTENT_TYPES.includes(contentType)) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Only JPEG, PNG, or WebP images are allowed.' }) };
      }
      if (!fileSize || fileSize > MAX_PUBLIC_UPLOAD_BYTES) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `File must be under ${MAX_PUBLIC_UPLOAD_BYTES / (1024 * 1024)}MB.` }) };
      }
    } else {
      // Admin-managed folder (contestants, brands, gallery, etc.) — require
      // a valid Supabase session, same as before.
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Supabase credentials are not configured on the server.' }) };
      }
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const isAdmin = await verifySupabaseUser(token);
      if (!isAdmin) {
        return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Not authenticated.' }) };
      }
    }

    const { apiUrl, bucketId, downloadUrl, authToken } = await authorizeB2();

    const uploadUrlRes = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucketId }),
    });
    if (!uploadUrlRes.ok) {
      throw new Error(`b2_get_upload_url failed: ${uploadUrlRes.status} ${await uploadUrlRes.text()}`);
    }
    const uploadUrlData = await uploadUrlRes.json();

    const cleanFolder = folder ? sanitizeSegment(folder) : 'uploads';
    const uniqueName = `${cleanFolder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeSegment(fileName)}`;
    const encodedName = uniqueName.split('/').map(encodeURIComponent).join('/');

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadUrl: uploadUrlData.uploadUrl,
        authorizationToken: uploadUrlData.authorizationToken,
        fileName: uniqueName,
        publicUrl: `${downloadUrl}/file/${B2_BUCKET_NAME}/${encodedName}`,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
