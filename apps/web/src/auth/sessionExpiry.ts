import { consoleLoginHref, currentReturnTo } from '@/auth/returnTo';

let resetIdentity: (() => void) | undefined;
let redirectStarted = false;
let navigateToLogin = (href: string) => window.location.replace(href);

export function registerIdentityReset(handler: () => void): void {
  resetIdentity = handler;
}

/** Centralized handling for control-plane 401s, including CSV and Docs Try It. */
export function handleControlPlaneUnauthorized(): void {
  resetIdentity?.();
  if (typeof window === 'undefined' || redirectStarted) return;
  const path = window.location.pathname.toLowerCase();
  if (
    path === '/login' ||
    path.startsWith('/login/') ||
    path === '/auth' ||
    path.startsWith('/auth/')
  ) {
    return;
  }

  redirectStarted = true;
  navigateToLogin(consoleLoginHref(currentReturnTo(), true));
}

export function resetUnauthorizedRedirectForTests(): void {
  redirectStarted = false;
  resetIdentity = undefined;
  navigateToLogin = (href: string) => window.location.replace(href);
}

export function setUnauthorizedNavigationForTests(handler: (href: string) => void): void {
  navigateToLogin = handler;
}
