// Orientation tracking without a browser: a fake window (an EventTarget) and a
// hand-driven clock stand in for the device.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OrientationTracker, viewDirection } from '../js/sensors/orientation.js';

const ABS = 'deviceorientationabsolute';
const REL = 'deviceorientation';

function fakeWindow({ absolute = true, permission } = {}) {
  const win = new EventTarget();
  win.DeviceOrientationEvent = class {};
  if (permission) win.DeviceOrientationEvent.requestPermission = permission;
  if (absolute) win.ondeviceorientationabsolute = null;
  win.isSecureContext = true;
  return win;
}

function fire(win, type, alpha, beta, gamma, extra = {}) {
  win.dispatchEvent(Object.assign(new Event(type), { alpha, beta, gamma, absolute: type === ABS, ...extra }));
}

async function started(options) {
  const win = fakeWindow(options);
  const clock = { t: 0 };
  const tracker = new OrientationTracker({ target: win, now: () => clock.t });
  const result = await tracker.start();
  return { win, clock, tracker, result };
}

const heading = (tracker) => tracker.headingOf(tracker.target);
const near = (a, b, tol = 1e-6) => Math.abs(((a - b + 540) % 360) - 180) < tol;

test('alpha, beta, gamma map to the direction the back of the phone faces', () => {
  const cases = [
    // alpha, beta, gamma -> azimuth, altitude
    [[0, 90, 0], [0, 0]], // upright, facing north
    [[90, 90, 0], [270, 0]], // alpha grows counter-clockwise: turned to the west
    [[270, 90, 0], [90, 0]], // east
    [[0, 135, 0], [0, 45]], // tipped back: looking 45 deg up
    [[0, 45, 0], [0, -45]], // tipped forward: looking 45 deg down
    [[180, 60, 0], [180, -30]], // facing south, looking 30 deg down
    [[0, 90, 30], [330, 0]], // upright and turned about its long axis
  ];
  for (const [[a, b, g], [az, alt]] of cases) {
    const v = viewDirection(a, b, g);
    assert.ok(near(v.az, az, 1e-6), `azimuth for ${a},${b},${g}: ${v.az}`);
    assert.ok(Math.abs(v.alt - alt) < 1e-6, `altitude for ${a},${b},${g}: ${v.alt}`);
  }
  assert.ok(Math.abs(viewDirection(40, 0, 0).alt + 90) < 1e-6, 'flat on a table looks straight down');
  assert.ok(Math.abs(viewDirection(40, 180, 0).alt - 90) < 1e-6, 'face down looks straight up');
});

test('start() attaches listeners and returns at once, without waiting for data', async () => {
  const { tracker, result } = await started();
  assert.deepEqual(result, { ok: true });
  assert.equal(tracker.active, true);
  assert.equal(tracker.hasData, false);
  assert.equal(tracker.step(0.016), null);
});

test('readings that arrive long after start are still used (no timeout)', async () => {
  const { win, clock, tracker } = await started();
  clock.t = 10 * 60 * 1000; // ten minutes of silence
  assert.equal(tracker.active, true);
  fire(win, ABS, 0, 90, 0);
  assert.equal(tracker.hasData, true);
  assert.ok(near(heading(tracker), 0));
});

test('the absolute stream is preferred over the relative one', async () => {
  const { win, clock, tracker } = await started();
  fire(win, REL, 123, 90, 0); // arbitrary yaw
  fire(win, ABS, 10, 90, 0);
  assert.equal(tracker.source, 'absolute');
  assert.equal(tracker.hasHeading, true);
  assert.ok(near(heading(tracker), 350));
  clock.t = 5000;
  fire(win, REL, 200, 90, 0); // ignored from now on
  assert.ok(near(heading(tracker), 350));
  fire(win, ABS, 90, 135, 0);
  assert.ok(near(heading(tracker), 270));
});

test('relative readings give the absolute stream a short head start, then take over', async () => {
  const { win, clock, tracker } = await started();
  clock.t = 100;
  fire(win, REL, 45, 90, 0);
  assert.equal(tracker.hasData, false, 'still inside the head start');
  clock.t = 400;
  fire(win, REL, 45, 90, 0);
  assert.equal(tracker.hasData, true);
  assert.equal(tracker.source, 'relative');
  assert.equal(tracker.hasHeading, false);
  assert.ok(near(heading(tracker), 315));
  // A late absolute reading takes over, and the filter jumps to it.
  tracker.step(0.016);
  fire(win, ABS, 0, 90, 0);
  assert.equal(tracker.source, 'absolute');
  assert.equal(tracker.smoothed, null);
  assert.ok(near(tracker.headingOf(tracker.step(0.016).q), 0));
});

test('an all-null absolute event (no such sensor) hands over to the fallback immediately', async () => {
  const { win, clock, tracker } = await started();
  clock.t = 5;
  fire(win, ABS, null, null, null);
  clock.t = 10;
  fire(win, REL, 30, 90, 0);
  assert.equal(tracker.hasData, true);
  assert.equal(tracker.source, 'relative');
  assert.ok(near(heading(tracker), 330));
});

test('browsers without the absolute event use deviceorientation straight away', async () => {
  const { win, tracker } = await started({ absolute: false });
  fire(win, REL, 30, 60, 0);
  assert.equal(tracker.source, 'relative');
  assert.ok(near(heading(tracker), 330));
  // Plain events flagged absolute (older WebViews, Firefox) count as a compass.
  fire(win, REL, 90, 90, 0, { absolute: true });
  assert.equal(tracker.source, 'absolute');
  assert.equal(tracker.hasHeading, true);
});

test('missing angles: tilt-only fallback readings work, incomplete absolute ones do not count', async () => {
  const { win, clock, tracker } = await started();
  fire(win, ABS, null, 80, 0); // no alpha: not an absolute reading
  assert.equal(tracker.hasData, false);
  clock.t = 1;
  fire(win, REL, null, 135, 0); // accelerometer-only device
  assert.equal(tracker.hasData, true);
  const f = tracker.basis(tracker.target).forward;
  assert.ok(Math.abs(Math.asin(f[2]) * 180 / Math.PI - 45) < 1e-6);
  fire(win, REL, null, null, null); // ignored
  assert.equal(tracker.source, 'relative');
});

test('iOS: relative readings are turned to the compass heading', async () => {
  const { win, tracker } = await started({ absolute: false });
  // Arbitrary relative yaw; the compass says the camera faces 200 deg.
  fire(win, REL, 37, 60, 0, { webkitCompassHeading: 200, webkitCompassAccuracy: 10 });
  assert.equal(tracker.headingSource, 'compass');
  assert.ok(near(heading(tracker), 200, 1e-6));
  // An unreliable compass value is not used.
  const other = await started({ absolute: false });
  fire(other.win, REL, 37, 60, 0, { webkitCompassHeading: 200, webkitCompassAccuracy: -1 });
  assert.equal(other.tracker.headingSource, 'none');
});

test('declination and calibration turn the heading, and apply without waiting for an event', async () => {
  const { win, tracker } = await started();
  let changes = 0;
  tracker.onChange = () => { changes++; };
  fire(win, ABS, 0, 90, 0);
  tracker.declination = 10;
  assert.ok(near(heading(tracker), 10));
  tracker.calibration = -25;
  assert.ok(near(heading(tracker), 345));
  assert.equal(changes, 3);
  // Without a compass the magnetic declination has no meaning; calibration still does.
  const rel = await started({ absolute: false });
  rel.tracker.declination = 10;
  rel.tracker.calibration = 5;
  fire(rel.win, REL, 0, 90, 0);
  assert.ok(near(heading(rel.tracker), 5));
});

test('stop() detaches, resume() listens again without a permission request', async () => {
  let asked = 0;
  const { win, tracker } = await started({ permission: async () => { asked++; return 'granted'; } });
  assert.equal(asked, 1);
  fire(win, ABS, 0, 90, 0);
  tracker.stop();
  fire(win, ABS, 90, 90, 0);
  assert.ok(near(heading(tracker), 0), 'events after stop() are ignored');
  tracker.resume();
  assert.equal(asked, 1);
  fire(win, ABS, 90, 90, 0);
  assert.ok(near(heading(tracker), 270));
});

test('permission: only a clear refusal stops the tracker', async () => {
  const denied = await started({ permission: async () => 'denied' });
  assert.deepEqual(denied.result, { ok: false, reason: 'denied' });
  assert.equal(denied.tracker.active, false);

  const insecure = fakeWindow({ permission: async () => 'denied' });
  insecure.isSecureContext = false;
  assert.deepEqual(await new OrientationTracker({ target: insecure }).start(), { ok: false, reason: 'insecure' });

  // Neither yes nor no (a browser without a prompt), or a failing call: keep
  // listening, since Android delivers the events regardless.
  const unanswered = await started({ permission: async () => 'prompt' });
  assert.deepEqual(unanswered.result, { ok: true });
  assert.equal(unanswered.tracker.active, true);
  const throwing = await started({ permission: async () => { throw new Error('no gesture'); } });
  assert.deepEqual(throwing.result, { ok: true });
  assert.equal(throwing.tracker.active, true);

  const none = await new OrientationTracker({ target: new EventTarget() }).start();
  assert.deepEqual(none, { ok: false, reason: 'unsupported' });
});

test('the smoothing filter settles on the reading and reports when it is still moving', async () => {
  const { win, tracker } = await started();
  fire(win, ABS, 0, 90, 0);
  assert.equal(tracker.step(0.016).moving, false);
  fire(win, ABS, 20, 90, 0);
  assert.equal(tracker.needsFrame(), true);
  let s;
  for (let i = 0; i < 60; i++) s = tracker.step(0.016);
  assert.equal(s.moving, false);
  assert.ok(near(tracker.headingOf(s.q), 340, 0.01));
  assert.equal(tracker.needsFrame(), false);
});
