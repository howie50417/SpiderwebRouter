const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

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

export function currentReturnTo(): string {
  if (typeof window === 'undefined') return '/';
  return sanitizeReturnTo(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
}

export function consoleLoginHref(returnTo: unknown, expired = false): string {
  const query = new URLSearchParams({ returnTo: sanitizeReturnTo(returnTo) });
  if (expired) query.set('reason', 'expired');
  return `/login?${query.toString()}`;
}
