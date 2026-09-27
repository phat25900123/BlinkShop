export function publicOrigin(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall back to the request origin when local configuration is invalid.
    }
  }

  return new URL(requestUrl).origin;
}
