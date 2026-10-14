const MEDIA = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture', 'speaker-selection']);
const OTHER = new Set(['fullscreen', 'notifications', 'pointerLock', 'clipboard-sanitized-write', 'clipboard-read']);

/** Electron passes the site as a URL (`https://host/`), not `new URL(site).origin`. */
function originOf(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  try { return new URL(value).origin; } catch { return ''; }
}

function listedOrigins(requestingOrigin, details) {
  const values = [
    requestingOrigin,
    details && details.securityOrigin,
    details && details.requestingUrl,
    details && details.embeddingOrigin,
  ];
  return values.map(originOf).filter(Boolean);
}

/**
 * Media checks must succeed for the live site or device enumeration returns
 * cameras and mics with empty ids and labels. A check with no origin at all
 * is the device enumerator, not another website.
 */
function mediaOriginAllowed(requestingOrigin, details, siteOrigin) {
  const origins = listedOrigins(requestingOrigin, details);
  if (origins.length === 0) return true;
  return origins.every((origin) => origin === siteOrigin);
}

function decidePermissionCheck(permission, requestingOrigin, details, siteOrigin) {
  if (MEDIA.has(permission)) return mediaOriginAllowed(requestingOrigin, details, siteOrigin);
  return OTHER.has(permission);
}

function decidePermissionRequest(permission, details, siteOrigin) {
  if (MEDIA.has(permission)) return mediaOriginAllowed('', details, siteOrigin);
  return OTHER.has(permission);
}

/** Windows desktop-app privacy toggles. `granted` and `unknown` are not a block. */
function windowsMediaBlock(cameraStatus, microphoneStatus) {
  const blocked = [];
  if (cameraStatus === 'denied' || cameraStatus === 'restricted') blocked.push('camera');
  if (microphoneStatus === 'denied' || microphoneStatus === 'restricted') blocked.push('microphone');
  if (blocked.length === 0) return null;
  const noun = blocked.join(' and ');
  return {
    message: `Windows is blocking the ${noun} for desktop apps.`,
    detail: 'A browser can still see the camera and microphone when this is off. Open Settings, then Privacy & security, then Camera, and the same page for Microphone. Turn access on, including "Let desktop apps access your camera" and "Let desktop apps access your microphone". Then restart zeronoise.',
  };
}

module.exports = {
  decidePermissionCheck,
  decidePermissionRequest,
  windowsMediaBlock,
  originOf,
};
