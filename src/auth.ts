import crypto from "crypto";

export type Perfil = "ADMIN" | "CLIENTE";

export type AuthPayload = {
  sub: number;
  perfil: Perfil;
  exp: number;
};

const TOKEN_DURATION_SECONDS = 8 * 60 * 60;
const authSecret =
  process.env.AUTH_SECRET?.trim() || crypto.randomBytes(32).toString("hex");

if (!process.env.AUTH_SECRET?.trim()) {
  console.warn(
    "AVISO: AUTH_SECRET não foi definido. Os acessos serão invalidados quando o servidor reiniciar.",
  );
}

function encode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string) {
  return crypto.createHmac("sha256", authSecret).update(value).digest("base64url");
}

export function createAuthToken(sub: number, perfil: Perfil) {
  const payload: AuthPayload = {
    sub,
    perfil,
    exp: Math.floor(Date.now() / 1000) + TOKEN_DURATION_SECONDS,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyAuthToken(token: string): AuthPayload | null {
  const [encodedPayload, receivedSignature] = token.split(".");
  if (!encodedPayload || !receivedSignature) return null;

  const expectedSignature = sign(encodedPayload);
  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(expectedSignature);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as AuthPayload;

    if (
      !Number.isInteger(payload.sub) ||
      !["ADMIN", "CLIENTE"].includes(payload.perfil) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function isPasswordHash(value: string) {
  return /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/i.test(value);
}

export function verifyPassword(password: string, storedValue: string) {
  if (!isPasswordHash(storedValue)) return false;

  const [, salt, storedHash] = storedValue.split("$");
  if (!salt || !storedHash) return false;

  const calculatedHash = crypto.scryptSync(password, salt, 64);
  const storedHashBuffer = Buffer.from(storedHash, "hex");
  return (
    calculatedHash.length === storedHashBuffer.length &&
    crypto.timingSafeEqual(calculatedHash, storedHashBuffer)
  );
}
