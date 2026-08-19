/**
 * TURN credential minting (ADR-0005, ADR-0007).
 *
 * These do not test coturn. They test the two things this repo can get wrong on its own and which
 * both fail SILENTLY: a digest encoding coturn does not accept (every allocation refused, and the
 * browser reports it only as "ICE failed"), and issuing a credential when none was asked for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mintIce, type TurnConfig } from '../src/turn.ts';

const SECRET = 'turn-test-secret';

/** No process.env and no cached config: `mintIce` takes both as arguments, so these are pure. */
const relay = (...urls: string[]): TurnConfig => ({ turnUrls: urls, turnTtlSeconds: 12 * 3600 });

describe('minting TURN credentials', () => {
  test('an unconfigured relay mints nothing rather than inventing a server', async () => {
    // The console renders null as a sentence about the live view having no relay. A fabricated
    // public STUN server here would produce a viewer that works at a desk and fails from a phone
    // hotspot, with nothing anywhere saying why.
    assert.equal(mintIce('sess-1', relay(), SECRET), null, 'no urls');
    assert.equal(mintIce('sess-1', relay('turn:relay.example:3478'), undefined), null, 'no secret');
  });

  test('the credential is base64 of the raw HMAC-SHA1, which is what coturn recomputes', async () => {
    const now = 1_760_000_000_000;
    const block = mintIce('sess-abc', relay('turn:relay.example:3478'), SECRET, now)!;
    assert.ok(block, 'a configured relay mints');

    const [server] = block.iceServers;
    const expectedUser = `${Math.floor(now / 1000) + block.expiresInSeconds}:sess-abc`;
    assert.equal(server.username, expectedUser);
    assert.equal(
      server.credential,
      createHmac('sha1', SECRET).update(expectedUser).digest('base64'),
      'hex here is the classic silent failure — coturn 401s every allocation and the browser only says "ICE failed"',
    );
  });

  test('the username carries the expiry and the session, in that order', async () => {
    const now = 1_760_000_000_000;
    const block = mintIce('sess-xyz', relay('turn:relay.example:3478'), SECRET, now)!;
    const [expiry, ...rest] = block.iceServers[0].username!.split(':');
    // coturn parses everything before the first colon as a unix timestamp and ignores the rest.
    // The session id rides along so the relay's access log can be attributed.
    assert.equal(Number(expiry), Math.floor(now / 1000) + block.expiresInSeconds);
    assert.equal(rest.join(':'), 'sess-xyz');
  });

  test('every configured url is offered, not just the first', async () => {
    // A working relay is normally several urls — udp, tcp, and 443 for networks that allow nothing
    // else. Offering one of them is how the hotspot case fails.
    const cfg = relay('turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp', 'turns:relay.example:5349');
    assert.deepEqual(mintIce('s', cfg, SECRET)!.iceServers[0].urls, [
      'turn:relay.example:3478',
      'turn:relay.example:3478?transport=tcp',
      'turns:relay.example:5349',
    ]);
  });

  test('two sessions never share a credential', async () => {
    const cfg = relay('turn:relay.example:3478');
    const a = mintIce('sess-a', cfg, SECRET, 1_760_000_000_000)!;
    const b = mintIce('sess-b', cfg, SECRET, 1_760_000_000_000)!;
    assert.notEqual(a.iceServers[0].credential, b.iceServers[0].credential);
  });
});
