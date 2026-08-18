/**
 * `mfarm app` — upload a build, list the library, install onto a device you hold.
 *
 * Same harness as the rest of the CLI suite: a real control plane on a real port and the real
 * binary as a real child process. What these tests are actually about is the EXIT CODE, because
 * that is the whole interface a CI step has. An install that failed on the device and an install
 * this command simply stopped waiting for are different outcomes, and folding them together is what
 * makes a pipeline green while the app is not on the phone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, startControlPlane, APP_ID, INSTALL_ID, SESSION_ID } from './harness.ts';

/** Not a real APK: the CLI never parses one, so a byte pattern proves the transfer just as well. */
const APK = Buffer.alloc(5_000, 0x50);

async function withApk<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mfarm-cli-apk-'));
  const path = join(dir, 'example.apk');
  await writeFile(path, APK);
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('mfarm app upload', () => {
  test('streams the file and prints the build id', async () => {
    const cp = await startControlPlane();
    try {
      const res = await withApk((path) => runCli(['app', 'upload', path, '--api', cp.url]));
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout.trim(), APP_ID);

      const [upload] = cp.of('POST', '/v1/apps');
      assert.ok(upload);
      // The content type is what selects the streaming parser on the server. Sending JSON here
      // would be a 415 no amount of retrying fixes.
      assert.equal(upload.headers['content-type'], 'application/vnd.android.package-archive');
      assert.equal(upload.bodyBytes, APK.length);
      // The name travels as a query parameter, so the library can show something a human recognises.
      assert.match(upload.path, /filename=example\.apk/);
    } finally {
      await cp.close();
    }
  });

  test('says plainly when the build was already in the library', async () => {
    // A 200 rather than a 201 is the server saying "same digest, same build". Silence here reads as
    // "my upload did nothing", which is the one interpretation that would send someone debugging.
    const cp = await startControlPlane({ uploadStatus: 200 });
    try {
      const res = await withApk((path) => runCli(['app', 'upload', path, '--api', cp.url]));
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stderr, /already in the library/);
    } finally {
      await cp.close();
    }
  });

  test('a missing file fails without touching the control plane', async () => {
    const cp = await startControlPlane();
    try {
      const res = await runCli(['app', 'upload', '/nope/missing.apk', '--api', cp.url]);
      assert.equal(res.code, 1);
      assert.equal(cp.of('POST', '/v1/apps').length, 0);
    } finally {
      await cp.close();
    }
  });
});

describe('mfarm app install', () => {
  test('waits out the queue and exits 0 when the device has it', async () => {
    // PENDING first, because that is always the first answer: the worker collects the job on its
    // next heartbeat, so an install that is instantly INSTALLED would not exercise the wait at all.
    const cp = await startControlPlane({ installStates: ['PENDING', 'INSTALLED'] });
    try {
      const res = await runCli([
        'app', 'install', APP_ID, '--session', SESSION_ID, '--wait', '10', '--api', cp.url,
      ]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout.trim(), 'INSTALLED');
      assert.equal(cp.of('POST', `/v1/sessions/${SESSION_ID}/installs`).length, 1);
      assert.ok(cp.of('GET', `/v1/installs/${INSTALL_ID}`).length >= 2);
    } finally {
      await cp.close();
    }
  });

  test('a failed install exits non-zero with the reason the worker reported', async () => {
    const cp = await startControlPlane({
      installStates: ['FAILED'],
      installError: 'adb: Failure [INSTALL_FAILED_NO_MATCHING_ABIS]',
    });
    try {
      const res = await runCli([
        'app', 'install', APP_ID, '--session', SESSION_ID, '--wait', '10', '--api', cp.url,
      ]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /INSTALL_FAILED_NO_MATCHING_ABIS/);
    } finally {
      await cp.close();
    }
  });

  test('--wait 0 queues and returns success without polling', async () => {
    // For a script that wants to fire off an install and check it later. Not waiting is a choice
    // the caller made, so it is not a failure.
    const cp = await startControlPlane({ installStates: ['PENDING'] });
    try {
      const res = await runCli([
        'app', 'install', APP_ID, '--session', SESSION_ID, '--wait', '0', '--api', cp.url,
      ]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout.trim(), 'PENDING');
      assert.equal(cp.of('GET', `/v1/installs/${INSTALL_ID}`).length, 0);
    } finally {
      await cp.close();
    }
  });

  test('giving up waiting is a failure, and says so as itself', async () => {
    // Still PENDING when the clock runs out. Exiting 0 here would tell CI the app is installed.
    const cp = await startControlPlane({ installStates: ['PENDING'] });
    try {
      const res = await runCli([
        'app', 'install', APP_ID, '--session', SESSION_ID, '--wait', '2', '--api', cp.url,
      ]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /still pending/);
    } finally {
      await cp.close();
    }
  });

  test('without a session there is nothing to install onto', async () => {
    const cp = await startControlPlane();
    try {
      const res = await runCli(['app', 'install', APP_ID, '--api', cp.url], {
        env: { MFARM_SESSION_ID: '' },
      });
      assert.equal(res.code, 1);
      assert.match(res.stderr, /--session/);
      assert.equal(cp.requests.length, 0, 'a usage error must not reach the control plane');
    } finally {
      await cp.close();
    }
  });

  test('MFARM_SESSION_ID is enough, which is what makes it usable inside `mfarm run`', async () => {
    // `mfarm run` puts the session id in the child's environment, so a script it launches can
    // install onto the device the run already holds without being told which one that is.
    const cp = await startControlPlane({ installStates: ['INSTALLED'] });
    try {
      const res = await runCli(['app', 'install', APP_ID, '--api', cp.url], {
        env: { MFARM_SESSION_ID: SESSION_ID },
      });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(cp.of('POST', `/v1/sessions/${SESSION_ID}/installs`).length, 1);
    } finally {
      await cp.close();
    }
  });
});

describe('mfarm app list', () => {
  test('--json emits one object on one line', async () => {
    const cp = await startControlPlane();
    try {
      const res = await runCli(['app', 'list', '--json', '--api', cp.url]);
      assert.equal(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.apps.length, 1);
      assert.equal(parsed.apps[0].packageName, 'dev.mfarm.example');
      assert.equal(res.stdout.trimEnd().split('\n').length, 1);
    } finally {
      await cp.close();
    }
  });

  test('--package is passed through as a filter', async () => {
    const cp = await startControlPlane();
    try {
      await runCli(['app', 'list', '--package', 'dev.mfarm.example', '--api', cp.url]);
      assert.match(cp.of('GET', '/v1/apps')[0]!.path, /package=dev\.mfarm\.example/);
    } finally {
      await cp.close();
    }
  });
});
