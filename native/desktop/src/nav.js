const { createHash, randomBytes } = require('crypto');

const OAUTH_PATHS = new Set(['/api/auth/google', '/api/auth/discord']);

function newVerifier() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function classifyNavigation(raw, siteOrigin) {
  let url;
  try { url = new URL(raw); } catch { return { action: 'ignore' }; }
  if (url.protocol === 'camchat:') return { action: 'auth', url };
  if (url.origin === siteOrigin && OAUTH_PATHS.has(url.pathname)) return { action: 'oauth', url };
  if (url.origin === siteOrigin && (url.protocol === 'https:' || url.protocol === 'http:')) return { action: 'inapp' };
  if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' || url.protocol === 'tel:') {
    return { action: 'external', url };
  }
  return { action: 'ignore' };
}

function withNativeChallenge(raw, challenge) {
  const url = new URL(raw);
  url.searchParams.set('client', 'native');
  url.searchParams.set('nonce', challenge);
  return url.toString();
}

function parseAuthCallback(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'camchat:' || url.hostname !== 'auth') return null;
  return {
    challenge: url.searchParams.get('nonce') || '',
    token: url.searchParams.get('token') || '',
    error: url.searchParams.get('error') || '',
  };
}

function handoffPage(siteUrl, token, verifier) {
  const url = new URL('/api/auth/native', siteUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('verifier', verifier);
  return url.toString();
}

function authErrorPage(siteUrl, error) {
  const url = new URL('/', siteUrl);
  url.searchParams.set('authError', error || 'Sign-in failed.');
  return url.toString();
}

module.exports = {
  newVerifier, classifyNavigation, withNativeChallenge, parseAuthCallback, handoffPage, authErrorPage,
};
