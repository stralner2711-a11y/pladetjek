import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthCallback } from "./auth-callback";
import { getAccountEmailFlow } from "./account-service";

test("opgraderer samme anonyme konto ved oprettelse", () => {
  assert.equal(getAccountEmailFlow(true, true), "upgrade_anonymous");
});

test("login forsøger altid at hente en eksisterende konto", () => {
  assert.equal(getAccountEmailFlow(false, true), "sign_in_existing");
  assert.equal(getAccountEmailFlow(false, false), "sign_in_existing");
});

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
