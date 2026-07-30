import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthCallback } from "./auth-callback";

test("læser Supabase-session fra Android-loginlinkets fragment", () => {
  assert.deepEqual(
    parseAuthCallback(
      "dk.pladetjek.app://login-callback#access_token=access123&refresh_token=refresh456&type=magiclink",
    ),
    {
      accessToken: "access123",
      refreshToken: "refresh456",
      code: null,
    },
  );
});

test("læser PKCE-kode fra Android-loginlink", () => {
  assert.deepEqual(
    parseAuthCallback("dk.pladetjek.app://login-callback?code=pkce789"),
    {
      accessToken: null,
      refreshToken: null,
      code: "pkce789",
    },
  );
});
