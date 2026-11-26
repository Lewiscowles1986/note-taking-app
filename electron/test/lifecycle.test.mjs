import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShutdownTracker,
  createServerExitHandler,
  createRestartPolicy,
} from '../lifecycle.mjs';

describe('createShutdownTracker', () => {
  it('reports an exit the app did not ask for', () => {
    const tracker = createShutdownTracker();
    assert.equal(tracker.shouldReportExit(), true);
  });

  it('stays quiet when before-quit already asked the server to stop', () => {
    const tracker = createShutdownTracker();
    tracker.begin();
    assert.equal(tracker.shouldReportExit(), false);
  });

  it('reports at most once, however many times the child exits', () => {
    const tracker = createShutdownTracker();
    assert.equal(tracker.shouldReportExit(), true);
    assert.equal(tracker.shouldReportExit(), false);
    assert.equal(tracker.shouldReportExit(), false);
  });

  it('keeps quiet for an exit that lands after the app began shutting down', () => {
    const tracker = createShutdownTracker();
    tracker.begin();
    assert.equal(tracker.isShuttingDown(), true);
    assert.equal(tracker.shouldReportExit(), false);
  });
});

describe('createServerExitHandler', () => {
  function harness() {
    const dialogs = [];
    const quits = [];
    const tracker = createShutdownTracker();
    const handle = createServerExitHandler({
      tracker,
      port: 4173,
      showErrorBox: (title, message) => dialogs.push({ title, message }),
      quit: () => quits.push('quit'),
    });
    return { tracker, handle, dialogs, quits };
  }

  it('says nothing when the app quit on purpose', () => {
    const { tracker, handle, dialogs, quits } = harness();
    tracker.begin(); // before-quit ran, then the child's exit arrives
    handle(15);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(quits, []);
  });

  it('tells the user when the server dies on its own', () => {
    const { handle, dialogs, quits } = harness();
    handle(1);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, 'Note Haven stopped');
    assert.match(dialogs[0].message, /exited \(code 1\)/);
    assert.deepEqual(quits, ['quit']);
  });

  it('shows the dialog at most once', () => {
    const { handle, dialogs } = harness();
    handle(1);
    handle(1);
    assert.equal(dialogs.length, 1);
  });

  it('restarts instead of quitting when a restart is possible', () => {
    const dialogs = [];
    const quits = [];
    const restarts = [];
    const handle = createServerExitHandler({
      tracker: createShutdownTracker(),
      port: 4173,
      showErrorBox: (title, message) => dialogs.push({ title, message }),
      quit: () => quits.push('quit'),
      restart: () => restarts.push('restart'),
    });

    handle(1);

    assert.deepEqual(dialogs, []);
    assert.deepEqual(quits, []);
    assert.deepEqual(restarts, ['restart']);
  });

  it('falls back to the dialog when there is no restart available', () => {
    const { handle, dialogs, quits } = harness();
    handle(1);
    assert.equal(dialogs.length, 1);
    assert.deepEqual(quits, ['quit']);
  });

  it('still says nothing during an intentional quit, even with a restart available', () => {
    const dialogs = [];
    const restarts = [];
    const tracker = createShutdownTracker();
    const handle = createServerExitHandler({
      tracker,
      port: 4173,
      showErrorBox: (title, message) => dialogs.push({ title, message }),
      quit: () => {},
      restart: () => restarts.push('restart'),
    });
    tracker.begin();
    handle(15);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(restarts, []);
  });
});

describe('createRestartPolicy', () => {
  it('backs off further on each consecutive failure', () => {
    const policy = createRestartPolicy();
    assert.deepEqual([policy.nextDelay(), policy.nextDelay(), policy.nextDelay()], [250, 500, 750]);
  });

  it('caps the delay so a long outage still retries promptly', () => {
    const policy = createRestartPolicy();
    for (let i = 0; i < 100; i += 1) policy.nextDelay();
    assert.equal(policy.nextDelay(), 5000);
  });

  it('forgets previous failures once the server has been healthy', () => {
    const policy = createRestartPolicy();
    policy.nextDelay();
    policy.nextDelay();
    policy.recordHealthyUptime(10_000);
    assert.equal(policy.nextDelay(), 250);
  });

  it('keeps counting when the server died too soon to be healthy', () => {
    const policy = createRestartPolicy();
    policy.nextDelay();
    policy.recordHealthyUptime(1_000);
    assert.equal(policy.nextDelay(), 500);
  });

  it('never runs out of attempts', () => {
    const policy = createRestartPolicy();
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(typeof policy.nextDelay(), 'number');
    }
  });
});
