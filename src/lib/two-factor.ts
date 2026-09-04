import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_ALGORITHM = "sha1";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const RECOVERY_CODE_CHUNKS = 4;
const RECOVERY_CODE_CHUNK_LENGTH = 4;
const RECOVERY_CODE_COUNT = 10;

function getEncryptionKey(): Buffer {
  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!raw) throw new Error("TWO_FACTOR_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted payload");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function base32Decode(secret: string): Buffer {
  const normalized = secret.replace(/=+$/g, "").toUpperCase();
  const cleaned = [...normalized].filter((char) => BASE32_ALPHABET.includes(char)).join("");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpUri({
  secret,
  accountName,
  issuer,
}: {
  secret: string
  accountName: string
  issuer: string
}): string {
  return [
    "otpauth://totp/",
    encodeURIComponent(issuer),
    ":",
    encodeURIComponent(accountName),
    "?secret=",
    secret,
    "&issuer=",
    encodeURIComponent(issuer),
    "&algorithm=SHA1",
    "&digits=6",
    "&period=30",
  ].join("");
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(TOTP_ALGORITHM, secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, "0");
}

export function verifyTotp(
  secret: string,
  token: string,
  now: number = Date.now() / 1000,
): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const normalized = secret.replace(/\s+/g, "").replace(/-/g, "");
  const key = base32Decode(normalized);
  const counter = Math.floor(now / TOTP_PERIOD_SECONDS);
  for (let window = -1; window <= 1; window++) {
    if (hotp(key, counter + window) === token) return true;
  }
  return false;
}

export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    const alphabet = BASE32_ALPHABET;
    let code = "";
    for (let chunk = 0; chunk < RECOVERY_CODE_CHUNKS; chunk++) {
      if (chunk > 0) code += "-";
      for (let i = 0; i < RECOVERY_CODE_CHUNK_LENGTH; i++) {
        code += alphabet[randomInt(alphabet.length)];
      }
    }
    codes.add(code);
  }
  return [...codes];
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return createHash("sha256").update(code).digest("hex");
}

export async function verifyRecoveryCode(
  code: string,
  hash: string,
): Promise<boolean> {
  const candidate = await hashRecoveryCode(code);
  return candidate === hash.toLowerCase();
}