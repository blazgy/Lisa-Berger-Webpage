import path from "node:path";
import { webcrypto } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export const TEST_ADMIN_PASSWORD = "test-admin-password-123";

async function hashForTests(password: string): Promise<string> {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, key, 256);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  return `pbkdf2$1000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          ADMIN_PASSWORD_HASH: await hashForTests(TEST_ADMIN_PASSWORD),
          SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
          PUBLIC_BASE_URL: "https://booking.test",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
