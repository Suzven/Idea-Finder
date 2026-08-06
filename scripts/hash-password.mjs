import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error("Использование: node scripts/hash-password.mjs 'пароль-не-короче-10-символов'");
  process.exit(1);
}

const salt = randomBytes(16);
const derived = scryptSync(password, salt, 64);
process.stdout.write(`scrypt$v1$${salt.toString("base64url")}$${derived.toString("base64url")}\n`);

