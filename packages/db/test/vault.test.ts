import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalKeyWrapper, SecretDecryptionError } from '@pager/core';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import { integrationCredentials, organizations } from '../src/schema.js';
import { CredentialVault } from '../src/vault.js';

const MASTER = randomBytes(32).toString('base64');
let handle: DatabaseHandle;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  handle = await createDatabase('pglite://memory');
  await migrate(handle);
  const rows = await handle.db.insert(organizations).values([{ name: 'A', slug: 'a' }, { name: 'B', slug: 'b' }]).returning();
  orgA = rows[0]!.id;
  orgB = rows[1]!.id;
});
afterEach(async () => {
  await handle.close();
});

describe('CredentialVault', () => {
  const secret = 'xoxb-1234567890-secret-token-wxyz';

  it('round-trips a secret and stores only ciphertext', async () => {
    const vault = new CredentialVault(handle.db, new LocalKeyWrapper(MASTER));
    const summary = await vault.put(orgA, 'slack.bot_token', secret);
    expect(summary.last4).toBe('…wxyz');
    expect(await vault.reveal(orgA, 'slack.bot_token')).toBe(secret);

    const raw = JSON.stringify(await handle.db.select().from(integrationCredentials));
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('secret-token');
  });

  it('describes what is configured without revealing it', async () => {
    const vault = new CredentialVault(handle.db, new LocalKeyWrapper(MASTER));
    await vault.put(orgA, 'datadog.api_key', 'dd-0123456789abcdef');
    const described = await vault.describe(orgA);
    expect(described).toEqual([expect.objectContaining({ kind: 'datadog.api_key', last4: '…cdef' })]);
    expect(JSON.stringify(described)).not.toContain('0123456789');
    expect(await vault.describe(orgB)).toEqual([]);
    expect(await vault.reveal(orgB, 'datadog.api_key')).toBeNull();
  });

  it('refuses a row copied into another workspace', async () => {
    // The ciphertext is bound to its workspace and kind, so moving it does not move access.
    const vault = new CredentialVault(handle.db, new LocalKeyWrapper(MASTER));
    await vault.put(orgA, 'slack.bot_token', secret);
    const [row] = await handle.db.select().from(integrationCredentials);
    await handle.db.insert(integrationCredentials).values({ ...row!, id: undefined as never, organizationId: orgB });
    await expect(vault.reveal(orgB, 'slack.bot_token')).rejects.toBeInstanceOf(SecretDecryptionError);
  });

  it('refuses to decrypt under a different master key', async () => {
    await new CredentialVault(handle.db, new LocalKeyWrapper(MASTER)).put(orgA, 'notion.token', 'secret_abcdefghijkl');
    const other = new CredentialVault(handle.db, new LocalKeyWrapper(randomBytes(32).toString('base64')));
    await expect(other.reveal(orgA, 'notion.token')).rejects.toThrow(/sealed with local:/);
  });

  it('rotates in place, keeping one row per kind', async () => {
    const vault = new CredentialVault(handle.db, new LocalKeyWrapper(MASTER));
    await vault.put(orgA, 'anthropic.api_key', 'sk-ant-first-0001');
    const rotated = await vault.put(orgA, 'anthropic.api_key', 'sk-ant-second-0002');
    expect(rotated.rotatedAt).not.toBeNull();
    expect(await vault.reveal(orgA, 'anthropic.api_key')).toBe('sk-ant-second-0002');
    expect(await handle.db.select().from(integrationCredentials)).toHaveLength(1);
  });

  it('refuses a malformed master key at construction', () => {
    expect(() => new LocalKeyWrapper('too-short')).toThrow(/32 bytes/);
  });
});
