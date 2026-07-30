export function parseAuthCallback(url: string) {
  const parsed = new URL(url);
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  return {
    accessToken: fragment.get("access_token") ?? parsed.searchParams.get("access_token"),
    refreshToken: fragment.get("refresh_token") ?? parsed.searchParams.get("refresh_token"),
    code: parsed.searchParams.get("code"),
  };
}
