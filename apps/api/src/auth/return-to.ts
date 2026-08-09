const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Accept only a same-origin path. This value is persisted server-side in the
 * short-lived OIDC flow and is therefore the sole redirect target trusted by
 * the callback.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || unsafePath(value)) return '/';

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '/';
  }
  if (unsafePath(decoded)) return '/';

  let url: URL;
  try {
    url = new URL(value, 'https://router.invalid');
  } catch {
    return '/';
  }
  if (url.origin !== 'https://router.invalid') return '/';

  const canonicalPath = url.pathname;
  let decodedCanonicalPath: string;
  try {
    decodedCanonicalPath = decodeURIComponent(canonicalPath);
  } catch {
    return '/';
  }
  if (unsafePath(canonicalPath) || unsafePath(decodedCanonicalPath)) return '/';

  return `${url.pathname}${url.search}${url.hash}`;
}

function unsafePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return true;
  if (value.includes('\\') || CONTROL_CHARACTERS.test(value)) return true;
  const path = value.split(/[?#]/, 1)[0]!.toLowerCase();
  return (
    path === '/login' || path.startsWith('/login/') || path === '/auth' || path.startsWith('/auth/')
  );
}
