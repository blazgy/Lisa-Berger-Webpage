// Usage: npm run hash-password   (prompts for the password; nothing is echoed or stored)
// Prints the value for the ADMIN_PASSWORD_HASH secret. Also accepts the password on stdin.
import { webcrypto as crypto } from "node:crypto";
import { createInterface } from "node:readline";

const b64url = (b) => Buffer.from(b).toString("base64url");

async function hash(password, iterations = 100_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

if (!process.stdin.isTTY) {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  console.log(await hash(data.replace(/\r?\n$/, "")));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = () => {};
  process.stdout.write("Admin-Passwort: ");
  rl.question("", async (pw) => {
    rl.close();
    process.stdout.write("\n");
    if (pw.length < 12) {
      console.error("Bitte mindestens 12 Zeichen verwenden.");
      process.exit(1);
    }
    console.log(await hash(pw));
  });
}
