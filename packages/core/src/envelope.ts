import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for tenant credentials.
 *
 * Each secret is encrypted with its own random 256-bit data key (AES-256-GCM), and
 * that data key is itself encrypted ("wrapped") by a key-encryption key that never
 * leaves the `KeyWrapper`. The database holds only ciphertext and wrapped keys.
 *
 * The ciphertext is bound to where it belongs — workspace and credential kind — as
 * GCM associated data, so a row copied into another workspace fails to decrypt
 * rather than handing one tenant another's token.
 *
 * `LocalKeyWrapper` uses PAGER_MASTER_KEY from the environment. To move the
 * key-encryption key into a KMS, implement `KeyWrapper` with the KMS's own
 * Encrypt/Decrypt (AWS KMS, GCP KMS, Vault transit): `wrap` sends the 32-byte data
 * key and stores the returned blob, `unwrap` sends the blob back. Nothing else
 * changes, and rows carry `keyId`, so old and new wrappers can coexist during a
 * migration.
 */

export interface KeyWrapper {
  /** Identifies the key-encryption key, stored beside each row. */
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string, keyId: string): Promise<Buffer>;
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedKey: string;
  keyId: string;
}

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    super(`Could not decrypt a stored credential: ${reason}`);
    this.name = 'SecretDecryptionError';
  }
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Wraps data keys with a 32-byte master key held in the environment. */
export class LocalKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(masterKeyBase64: string | undefined) {
    const key = Buffer.from(masterKeyBase64 ?? '', 'base64');
    if (key.length !== 32) {
      throw new Error('PAGER_MASTER_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`).');
    }
    this.key = key;
    // A fingerprint, not the key: enough to tell which master key sealed a row.
    this.keyId = `local:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  }

  async wrap(dataKey: Buffer): Promise<string> {
    const { ciphertext, iv, tag } = gcmEncrypt(this.key, dataKey, 'pager-data-key');
    return [iv, tag, ciphertext].map((b) => b.toString('base64')).join('.');
  }

  async unwrap(wrapped: string, keyId: string): Promise<Buffer> {
    if (keyId !== this.keyId) {
      throw new SecretDecryptionError(`it was sealed with ${keyId}, and this process holds ${this.keyId}`);
    }
    const [iv, tag, ciphertext] = wrapped.split('.').map((p) => Buffer.from(p, 'base64'));
    if (!iv || !tag || !ciphertext) throw new SecretDecryptionError('malformed wrapped key');
    try {
      return gcmDecrypt(this.key, ciphertext, iv, tag, 'pager-data-key');
    } catch {
      throw new SecretDecryptionError('the data key did not unwrap');
    }
  }
}

export async function seal(wrapper: KeyWrapper, plaintext: string, context: string): Promise<SealedSecret> {
  const dataKey = randomBytes(32);
  const { ciphertext, iv, tag } = gcmEncrypt(dataKey, Buffer.from(plaintext, 'utf8'), context);
  const wrappedKey = await wrapper.wrap(dataKey);
  dataKey.fill(0);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
    wrappedKey,
    keyId: wrapper.keyId,
  };
}

export async function unseal(wrapper: KeyWrapper, sealed: SealedSecret, context: string): Promise<string> {
  const dataKey = await wrapper.unwrap(sealed.wrappedKey, sealed.keyId);
  try {
    return gcmDecrypt(
      dataKey,
      Buffer.from(sealed.ciphertext, 'base64'),
      Buffer.from(sealed.iv, 'base64'),
      Buffer.from(sealed.authTag, 'base64'),
      context,
    ).toString('utf8');
  } catch {
    throw new SecretDecryptionError('the ciphertext does not belong here, or was altered');
  } finally {
    dataKey.fill(0);
  }
}
