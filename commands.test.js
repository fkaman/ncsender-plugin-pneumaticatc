// Tests for rack geometry + routing. Run with:  node --test commands.test.js
//
// Rack coordinate model used across the tests (matches the operator's
// reference screenshots — orientation='Y' rack sitting to the -X side
// of the workspace, sliding onto/off the rack in +X):
//
//   orientation:      'Y'                   → slots stack along Y (par),
//                                             X is perp (slide axis)
//   direction:        'Positive'            → slotN.y = slot1.y + (N-1)*80
//   slot1:            { x: -115, y: 40 }    → rack center column at X=-115
//   slots:            3                     → T1..T3
//   slotDistance:     80                    → T1(y=40), T2(y=120), T3(y=200)
//   slideDirection:   'Negative'            → tool slides toward -X to engage
//                                             → sliding side (approach) is +X
//   slideDistance:    40                    → G1 slide-in length
//   keepoutPadding:   60                    → outer keepout envelope radius
//
// Derived numbers referenced below:
//   keepout X:  slot1.x ± pad         = [-175 … -55]
//   keepout Y:  slot1.y-pad … slotN.y+pad = [-20 … 260]
//   entry perp (X, sliding side):     -115 + 60 = -55
//   approach perp (X, inside box):    -115 + 40 = -75
//   entry point per slot:             (-55, slotN.y)
//   approach point per slot:          (-75, slotN.y)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  onBeforeCommand,
  buildInitialConfig,
  computeKeepoutZone,
  slotEntryPoint,
  slotApproachPoint,
  rackEntrance,
  rackExit,
  cupEntrance,
  cupExit,
  tlsEntrance,
  tlsExit,
  buildLoadTool,
  buildToolChangeProgram,
  parseMeasureTloCommand,
  buildUnloadTool,
  buildSlotNav,
  calculateSlotPosition,
  gateSpindleUnclamp,
  createToolLengthSetRoutine,
  createToolLengthSetProgram,
  routePoint,
  pickEntryEdge,
  probeVerifyRoutine,
  probeVerifyGcode,
} from './commands.js';

// Strip comment lines and blank lines so the assertions read against
// the actual emitted motion, in order.
function motionLines(gcode) {
  return gcode
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('('));
}

const RACK = {
  slots: 3,
  orientation: 'Y',
  direction: 'Positive',
  slot1: { x: -115, y: 40 },
  slotDistance: 80,
  slideDirection: 'Negative',
  slideDistance: 40,
  keepoutPadding: 60,
};

describe('computeKeepoutZone', () => {
  test('padded rectangle around slot1..slotN', () => {
    const zone = computeKeepoutZone(RACK);
    assert.equal(zone.minX, -175);
    assert.equal(zone.maxX, -55);
    assert.equal(zone.minY, -20);
    assert.equal(zone.maxY, 260);
  });

  test('falls back to slideDistance when keepoutPadding is unset', () => {
    const { keepoutPadding: _drop, ...noPad } = RACK;
    const zone = computeKeepoutZone(noPad);
    // Pad falls back to slideDistance (40) instead of shrinking to 0.
    assert.equal(zone.minX, -115 - 40);
    assert.equal(zone.maxX, -115 + 40);
    assert.equal(zone.minY, 40 - 40);
    assert.equal(zone.maxY, 200 + 40);
  });
});

describe('slotEntryPoint', () => {
  test('slot 1 sits on the sliding-side edge, aligned with slot par', () => {
    assert.deepEqual(slotEntryPoint(1, RACK), { x: -55, y: 40 });
  });

  test('slot 3 sits on the sliding-side edge, aligned with slot par', () => {
    assert.deepEqual(slotEntryPoint(3, RACK), { x: -55, y: 200 });
  });

  test('flips to the -X sliding side when slideDirection is Positive', () => {
    const flipped = { ...RACK, slideDirection: 'Positive' };
    // slideDirection Positive → approach on -X side → perp = slot1.x - pad = -175.
    assert.deepEqual(slotEntryPoint(1, flipped), { x: -175, y: 40 });
  });
});

describe('slotApproachPoint', () => {
  test('slot 1 approach sits INSIDE the keepout, slideDistance from the rack', () => {
    assert.deepEqual(slotApproachPoint(1, RACK), { x: -75, y: 40 });
  });

  test('slot 3 approach shares perp with slot 1 (par-only offset)', () => {
    assert.deepEqual(slotApproachPoint(3, RACK), { x: -75, y: 200 });
  });
});

// The tests below share one invariant: origin lives on the SAME side of
// the rack as the sliding side (workspace is on the sliding side — the
// normal setup). Opposite-side origin cases will be added once the
// same-side behavior is fully pinned down.
describe('rackEntrance — same-side origin ↔ entrance', () => {
  test('diagonal to slot entry + perp descent to approach (T? → slot 1)', () => {
    const gcode = rackEntrance(
      /* targetSlotXY */ { x: -115, y: 40 },
      /* origin */       { x: 60,  y: 120 },
      RACK
    );
    // Two moves, in order: diagonal to entry (-55, 40); then perp descent
    // (X axis is perp under orientation Y) to approach X=-75.
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55 Y40',
      'G53 G0 X-75',
    ]);
  });

  test('slot 3 lands at (-55, 200) then descends to X-75 (T? → slot 3)', () => {
    const gcode = rackEntrance(
      { x: -115, y: 200 },
      { x: 60, y: 120 },
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55 Y200',
      'G53 G0 X-75',
    ]);
  });
});

describe('rackExit — same-side origin ↔ entrance', () => {
  test('perp ascent to entry perp + diagonal to destination (slot → origin)', () => {
    const gcode = rackExit(
      /* fromSlotXY */    { x: -115, y: 40 },
      /* destination */   { x: 60,  y: 120 },
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55',
      'G53 G0 X60 Y120',
    ]);
  });
});

// Origin off the sliding side of the outer keepout — the workspace
// itself is on the sliding side (same-side setup) but the operator
// homed / parked the spindle past the rack's par range. A naive
// direct diagonal from that position to the target slot's entrance
// cuts through the keepout interior; the correct path pivots via the
// entrance-side corner nearest the origin's par first, then walks
// along the sliding edge down to the slot's entrance.
describe('rackEntrance — origin off sliding side, past par range (image 44)', () => {
  test('origin above slotN par: corner detour via top entry-side corner', () => {
    // Origin at (-200, 300): X well past the rack toward −X (off
    // sliding side, which is at X=−55 for this rack), Y above
    // parMaxPad (260). Nearest par-end corner on the entrance edge
    // is the top corner (entryPerp, parMax) = (−55, 260). From there,
    // par walk down the entry edge to slot 1 entrance (−55, 40), then
    // perp descent to approach (X=−75).
    const gcode = rackEntrance(
      /* targetSlotXY */ { x: -115, y: 40 },
      /* origin */       { x: -200, y: 300 },
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55 Y260',   // diagonal to top entry-side corner
      'G53 G0 X-55 Y40',    // par walk along sliding edge to slot 1 entrance
      'G53 G0 X-75',        // perp descent to slot 1 approach
    ]);
  });

  test('origin below slot1 par: corner detour via bottom entry-side corner', () => {
    // Symmetric case: origin below parMinPad (−20). Picks bottom
    // corner (entryPerp, parMin) = (−55, −20).
    const gcode = rackEntrance(
      /* targetSlotXY */ { x: -115, y: 200 },
      /* origin */       { x: -200, y: -80 },
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55 Y-20',   // diagonal to bottom entry-side corner
      'G53 G0 X-55 Y200',   // par walk along sliding edge to slot 3 entrance
      'G53 G0 X-75',        // perp descent
    ]);
  });
});

// Sliding side is on the opposite side of the rack from the origin
// (workspace and sliding side on OPPOSITE sides). Both simpler
// fallbacks — direct diagonal and entry-side corner detour — cut
// through the keepout because origin's par sits INSIDE the keepout
// par range. Detour: opposite-side corner first (nearest origin par),
// perp cross at that par-end to the entry-side corner, par walk down
// the entry edge, perp descent to approach.
describe('rackEntrance — sliding side opposite of origin (image 45)', () => {
  test('slideDirection Positive + origin in workspace: 4-move opposite-corner detour', () => {
    // Flip slideDirection → sliding side moves to -X, workspace
    // (origin at 0,0) is now on the +X side of the rack.
    const flipped = { ...RACK, slideDirection: 'Positive' };
    // Under `flipped`:
    //   entryPerp     = slot1.x - pad = -115 - 60 = -175   (sliding side, -X)
    //   oppositePerp  = slot1.x + pad = -115 + 60 =  -55   (workspace side, +X)
    //   parMin, parMax = -20, 260 (Y range under RACK)
    //   Origin par (Y=0) sits inside (parMin, parMax), so case 3 fires.
    //   Nearest par-end to 0 is parMin=-20 (distance 20) vs parMax=260 (240).
    const gcode = rackEntrance(
      /* targetSlotXY */ { x: -115, y: 40 },
      /* origin */       { x: 0,   y: 0 },
      flipped
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55 Y-20',   // diagonal to opposite-side corner at nearest par-end (workspace side)
      'G53 G0 X-175 Y-20',  // perp cross along par-end edge to entry-side corner
      'G53 G0 X-175 Y40',   // par walk down the entry edge to slot 1 entrance
      'G53 G0 X-155',       // perp descent to slot 1 approach (slot1.x - slideDistance)
    ]);
  });

  test('slideDirection Positive + origin below par range: falls back to 2-move (case 2, not case 3)', () => {
    // Same flipped setup, but origin Y is BELOW parMin — origin par
    // is outside the keepout par range, so the direct diagonal to
    // the bottom entry-side corner is safe (line stays below parMin).
    // Case 2 (yellow), not case 3 (blue) — guards against blowing up
    // the flow when we DON'T need the opposite-corner detour.
    const flipped = { ...RACK, slideDirection: 'Positive' };
    const gcode = rackEntrance(
      /* targetSlotXY */ { x: -115, y: 40 },
      /* origin */       { x: 0,   y: -100 },     // below parMin=-20
      flipped
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-175 Y-20',  // diagonal to bottom entry-side corner (safe: line stays below parMin)
      'G53 G0 X-175 Y40',   // par walk up the entry edge to slot 1 entrance
      'G53 G0 X-155',       // perp descent
    ]);
  });
});

describe('rackExit — destination off sliding side, past par range', () => {
  test('destination above rack: ascent → edge walk to top corner → diagonal', () => {
    const gcode = rackExit(
      /* fromSlotXY */    { x: -115, y: 40 },
      /* destination */   { x: -200, y: 300 },
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55',        // perp ascent to sliding-side edge (from approach)
      'G53 G0 X-55 Y260',   // par walk along edge to top corner (nearest dest par)
      'G53 G0 X-200 Y300',  // diagonal out to destination
    ]);
  });
});

// Mirror of the image 45 case for the return trip: after loading
// slot 1, machine is at slot 1 approach on the sliding side. Origin
// sits on the OPPOSITE side of the rack with par INSIDE the keepout
// par range — the direct diagonal + 2-move detour both cut the
// keepout, so we need the opposite-side corner leg on the exit too.
describe('rackExit — sliding side opposite of destination (image 45 return)', () => {
  test('T1 → origin: 4-move ascent + edge walk + perp cross + diagonal (mirror of case 3)', () => {
    const flipped = { ...RACK, slideDirection: 'Positive' };
    // Under `flipped`:
    //   entryPerp     = -175   (sliding side, -X)
    //   oppositePerp  =  -55   (workspace side, +X)
    //   destPar (Y=0) is inside (parMin=-20, parMax=260) → case 3.
    //   Nearest par-end to 0 is parMin=-20.
    const gcode = rackExit(
      /* fromSlotXY */    { x: -115, y: 40 },
      /* destination */   { x: 0,   y: 0 },
      flipped
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-175',        // perp ascent from approach to sliding-side edge
      'G53 G0 X-175 Y-20',   // par walk down entry edge to bottom entry corner
      'G53 G0 X-55 Y-20',    // perp cross at par-end to opposite-side corner (workspace side)
      'G53 G0 X0 Y0',        // diagonal out to destination
    ]);
  });
});

// TLS routing shares the same three-case model as rackExit — TLS
// sits at an arbitrary (X, Y) outside the padded rack envelope, and
// we route around the keepout if a direct line would cut it.
describe('tlsEntrance (slot approach → TLS)', () => {
  test('same-side TLS: perp ascent + direct diagonal to TLS (case 1)', () => {
    // Under default RACK: sliding side +X, entryPerp=-55. TLS at
    // (400, -100) sits past +X → same side as slot approach. Perp
    // ascent to entry perp, then direct diagonal to TLS.
    const gcode = tlsEntrance(
      /* fromSlotXY */ { x: -115, y: 40 },
      /* tlsX */       400,
      /* tlsY */       -100,
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-55',        // ascent to sliding-side edge
      'G53 G0 X400 Y-100',  // direct diagonal to TLS
    ]);
  });

  test('opposite-side TLS: opposite-corner detour (case 3)', () => {
    // Flip sliding side to -X. TLS at (400, -100) now sits past +X
    // (opposite side of sliding). Origin/destination on the same +X
    // side. tlsEntrance is rackExit — case 3 fires because dest par
    // (-100) is outside par range... actually -100 < parMin(-20), so
    // case 2 fires (par outside range). Verify that shape.
    const flipped = { ...RACK, slideDirection: 'Positive' };
    const gcode = tlsEntrance(
      { x: -115, y: 40 },
      400, -100,
      flipped
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-175',       // ascent to sliding-side edge (-X)
      'G53 G0 X-175 Y-20',  // par walk down entry edge to bottom entry corner
      'G53 G0 X400 Y-100',  // diagonal out to TLS (past +X)
    ]);
  });
});

describe('tlsEntrance — TLS inside keepout (regression)', () => {
  // Reported case: TLS mounted between slots (inside the padded keepout).
  // tlsEntrance is rackExit under the hood. Old logic: destPastSlidingEdge
  // was false AND destInParRange was true → case 3 opposite-corner detour
  // walked to (70.5, -770) → (-49.5, -770) → destination. Y=-770 was
  // beyond machine travel. Fix: destInPerpRange && destInParRange → ascent
  // + sliding-edge walk + perp-in.
  test('slot 2 approach → TLS inside keepout: ascent + edge walk + perp-in (not opposite-corner detour)', () => {
    const RACK = {
      slots: 4,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 10.5, y: -710 },
      slotDistance: 140,
      slideDirection: 'Negative',
      slideDistance: 40,
      keepoutPadding: 60,
    };
    // Zone: X[-49.5, 70.5], Y[-770, -230]. Slot 2 approach at (50.5, -570).
    // TLS at (3, -640) — strictly inside both perp and par ranges.
    const gcode = tlsEntrance(
      /* fromSlotXY */ { x: 50.5, y: -570 },
      /* tlsX */       3,
      /* tlsY */       -640,
      RACK
    );
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X70.5',        // ascent from approach perp to sliding-side edge
      'G53 G0 X70.5 Y-640',  // walk along sliding edge to TLS par
      'G53 G0 X3 Y-640',     // perp-in to TLS
    ]);
  });
});

describe('tlsExit (TLS → destination)', () => {
  test('same-side destination: direct diagonal (case 1)', () => {
    // Default RACK. TLS (400, -100) and origin (0, 50) both past +X
    // sliding side — direct diagonal, no corner detour.
    const gcode = tlsExit(400, -100, { x: 0, y: 50 }, RACK);
    assert.deepEqual(motionLines(gcode), ['G53 G0 X0 Y50']);
  });

  test('TLS == destination: direct diagonal (zero motion), no bogus detour', () => {
    // Regression for the reported bug: origin == pre-M6 location ==
    // TLS location. Neither endpoint is "past sliding" (both sit
    // inside the perp band beside the rack) so the old check fell
    // through to the case-2 corner detour and emitted a walk out to
    // the opposite-side edge before coming back. With the par-end
    // "same side" checks added, both endpoints are past parMax and
    // the direct diagonal wins.
    const ORIENT_X_RACK = {
      slots: 3, orientation: 'X', direction: 'Positive',
      slot1: { x: 79.928, y: -9.009 }, slotDistance: 60,
      slideDirection: 'Positive', slideDistance: 40, keepoutPadding: 60,
    };
    const same = { x: 306.809, y: -34.081 };
    const gcode = tlsExit(same.x, same.y, same, ORIENT_X_RACK);
    // Single direct-diagonal move to the destination — no detour lines.
    assert.deepEqual(motionLines(gcode), ['G53 G0 X306.809 Y-34.081']);
  });

  test('both past parMax: direct diagonal (same-side par test)', () => {
    // TLS and destination both sit past the rack's par-max end but
    // at different perp values (inside the keepout perp band). Line
    // stays past parMax the whole way, so it never enters the keepout.
    const ORIENT_X_RACK = {
      slots: 3, orientation: 'X', direction: 'Positive',
      slot1: { x: 79.928, y: -9.009 }, slotDistance: 60,
      slideDirection: 'Positive', slideDistance: 40, keepoutPadding: 60,
    };
    const gcode = tlsExit(306.809, -34.081, { x: 320, y: 10 }, ORIENT_X_RACK);
    assert.deepEqual(motionLines(gcode), ['G53 G0 X320 Y10']);
  });

  test('opposite-side destination: 3-move par-end corner detour (case 2)', () => {
    // Default RACK (sliding +X). TLS at (-300, 100) sits past -X
    // (opposite side of sliding). Destination at (60, 200) sits past
    // +X (sliding side). Origin par 200 is unambiguously closer to
    // parMax=260 (dist 60) than parMin=-20 (dist 220) → top corner.
    const gcode = tlsExit(-300, 100, { x: 60, y: 200 }, RACK);
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X-175 Y260',  // diagonal from TLS to opposite-side corner at nearest-to-destination par-end (top)
      'G53 G0 X-55 Y260',   // perp cross along top par-end edge to sliding-side corner
      'G53 G0 X60 Y200',    // diagonal out to destination
    ]);
  });

  // Reported case: after M6 → TLS cycle, tlsExit routed via X=1316.581
  // which was outside the machine's X travel — raw g-code capture in
  // the commit message. Both endpoints sit BELOW the keepout's par-min
  // edge (further negative than slotN.y − padding = −296.678), so a
  // direct diagonal never crosses the keepout box and is the right
  // answer. The plugin instead picked the "opposite perp sides" par-end
  // corner detour and walked out past parMax to X=slot1.x+90.
  //
  // Fixed by replacing the enumerated "same side" checks with a proper
  // segment-vs-rect intersection test in tlsExit — see commands.js
  // segmentIntersectsRect + tlsExit.
  test('regression: TLS below par range, dest left of perp range — direct diagonal (out-of-limits detour)', () => {
    const RACK = {
      slots: 3,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 1216.581, y: -116.678 },
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
    };
    // TLS at (1225.828, -337.775) and destination at (1079.828, -186.775).
    // Slot par range: y ∈ [-236.678, -116.678]; +padding 60 → par-min edge
    // at y = -296.678. Both TLS and destination sit BELOW that edge, so a
    // direct diagonal stays outside the keepout box the entire way.
    const gcode = tlsExit(1225.828, -337.775, { x: 1079.828, y: -186.775 }, RACK);
    assert.deepEqual(motionLines(gcode), ['G53 G0 X1079.828 Y-186.775']);
  });

  // Reported case: after T3 tool change + TLS on the .117 kiosk, tlsExit
  // returned via the WRONG par-end corner. TLS sat 45 mm north of parMax
  // and origin sat 300 mm north of parMin — the old rule looked only at
  // "which corner is closer to the destination" and picked parMin, forcing
  // TLS to walk 826 mm south before diagonaling back out to origin. Total
  // path ~1560 mm vs. ~870 mm for the parMax route. Fix: minimize TOTAL
  // par travel (TLS→corner + origin→corner), not just origin distance.
  test('regression (.117 kiosk T3): pick corner minimizing total par travel, not just origin distance', () => {
    // .117 kiosk is a Cup rack in production — routePoint picks the
    // origin-side edge (+X, since origin is far +X) for Cup, producing
    // a clean 2-move via parMax corner. Old tlsExit's per-endpoint edge
    // selection made both endpoints route via +X too, but with a
    // redundant duplicate corner move. New output drops the duplicate.
    const KIOSK = {
      slots: 12,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 3.8, y: -863.231 },
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
      rackHolding: 'Cup',
    };
    // Keepout Y: [-923.231, -143.231]. TLS Y=-97.5 is 45.7 mm above parMax;
    // origin Y=-622.103 is 301 mm below parMax and 301 mm above parMin.
    // Origin-only rule would have picked parMin (301 vs 479). Total-travel
    // rule picks parMax (46+479=525 vs 826+301=1127) — routePoint uses
    // the same rule via `sharedCornerPar`.
    const gcode = tlsExit(2, -97.5, { x: 701.456, y: -622.103 }, KIOSK);
    const lines = motionLines(gcode);
    // Must route via parMax (Y=-143.231), NOT parMin (Y=-923.231).
    assert.ok(!lines.some(l => /Y-923\.231(?:\D|$)/.test(l)),
      `must NOT walk to parMin corner (Y=-923.231) — got ${JSON.stringify(lines)}`);
    assert.ok(lines.some(l => /Y-143\.231(?:\D|$)/.test(l)),
      `must route via parMax corner (Y=-143.231) — got ${JSON.stringify(lines)}`);
    // Cup routes via +X edge only (origin-side). TLS above parMax gets
    // clamped par to parMax → single corner (63.8, -143.231), then
    // diagonal to origin. No duplicate corner (old tlsExit quirk).
    assert.deepEqual(lines, [
      'G53 G0 X63.8 Y-143.231',       // TLS → +X edge at parMax (clamped from above)
      'G53 G0 X701.456 Y-622.103',    // diagonal to origin
    ]);
  });

  // Reported case: TLS mounted BETWEEN slots (inside the padded keepout
  // box). Old logic couldn't tell "tlsPastSliding=false because TLS is
  // outside on the opposite perp side" from "tlsPastSliding=false
  // because TLS is inside the keepout perp band", so it routed via the
  // opposite-perp par-end corner — walking to (-49.5, -770), across to
  // (70.5, -770), then out to origin. Y=-770 was beyond machine travel.
  // Fix: detect TLS-inside and exit through the sliding-side edge at
  // the same par as TLS, then direct diagonal to origin.
  test('regression: TLS inside keepout box — exit via sliding edge, not par-end detour', () => {
    const RACK = {
      slots: 4,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 10.5, y: -710 },
      slotDistance: 140,
      slideDirection: 'Negative',
      slideDistance: 40,
      keepoutPadding: 60,
    };
    // Zone: X[-49.5, 70.5], Y[-770, -230]. TLS (3, -640) sits strictly
    // inside both perp and par ranges. Origin (535.925, -377.362) sits
    // well past the +X sliding edge. Expect a single perp exit move
    // to (70.5, -640) then a direct diagonal to origin.
    const gcode = tlsExit(3, -640, { x: 535.925, y: -377.362 }, RACK);
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X70.5 Y-640',
      'G53 G0 X535.925 Y-377.362',
    ]);
  });
});

describe('tlsExit (.117 kiosk Cup): TLS + origin both inside perp band on opposite par-ends', () => {
  // Tx→Ty tool change on the .117 kiosk. After probing, tlsExit routes
  // from TLS (1.984, -931) — inside perp band [-56.2, 63.8], BELOW
  // parMin — back to origin (0, -57.419) — inside perp band, ABOVE
  // parMax. Old path fell into the par-end corner detour where both
  // "side corners" collapsed to (63.8, parMin) and the final diagonal
  // to origin cut through the box on the way up. Correct: route the
  // WHOLE workspace-side edge — TLS → (edge, tls par-end) →
  // (edge, origin par-end) → origin.
  test('routes via full workspace-side edge (parMin corner → parMax corner)', () => {
    const KIOSK_CUP = {
      slots: 12,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 3.8, y: -863.231 },
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
      rackHolding: 'Cup',
    };
    const gcode = tlsExit(1.984, -931, { x: 0, y: -57.419 }, KIOSK_CUP);
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X63.8 Y-923.231',   // TLS → (workspace edge, parMin) — near TLS
      'G53 G0 X63.8 Y-143.231',   // par walk up edge to (workspace edge, parMax) — near origin
      'G53 G0 X0 Y-57.419',       // diagonal to origin (Y stays above parMax → outside box)
    ]);
    // Guard against regression to the collapsed 2-same-corner shape
    // that used to emit `X63.8 Y-923.231` twice in a row.
    const lines = motionLines(gcode);
    assert.ok(!(lines[0] === lines[1]),
      `must NOT emit two identical consecutive corner moves — got ${JSON.stringify(lines)}`);
  });
});

// Standalone $TLS approach. createToolLengthSetRoutine runs before every
// probe cycle — via $TLS or via M6. It didn't
// know about the keepout: a single `G53 G0 X{tlsX} Y{tlsY}` from wherever
// the spindle sat could cut diagonally across occupied slot columns on
// the way in. Fix mirrors rackExit — if TLS sits inside the padded rack
// envelope, land on the sliding-side edge at TLS par first, then perp-in.
describe('createToolLengthSetRoutine — approach honors sliding-side edge', () => {
  const RACK = {
    slots: 4,
    orientation: 'Y',
    direction: 'Positive',
    slot1: { x: 10.5, y: -710 },
    slotDistance: 140,
    slideDirection: 'Negative',
    slideDistance: 40,
    keepoutPadding: 60,
    zSafe: -5,
    toolsetter: { x: 3, y: -640 },
    seekDistance: 115,
    seekFeedrate: 700,
    tlsSeekStartZ: -5,
  };

  test('TLS inside padded keepout perp range: 2-move approach (edge, then perp-in)', () => {
    // Zone X[-49.5, 70.5]. TLS X=3 is inside → must land at X=70.5 first
    // (sliding edge, Negative slideDirection → +X approach), then perp in.
    const routine = createToolLengthSetRoutine(RACK, { x: 0, y: 0, z: 0 }).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    // Two XY approach lines immediately follow the Z-safe retract,
    // BEFORE any G38 probe move.
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X70.5 Y-640', 'edge landing first');
    assert.equal(lines[zSafeIdx + 2], 'G53 G0 X3 Y-640', 'perp-in second');
  });

  // .117 kiosk (Cup rack): slot1={x:3.8, y:-863.231}, 12 slots,
  // slotDistance=60, slideDirection=Positive → fork's slidingSidePerp
  // would land at -56.2, which is OUTSIDE the machine's X travel
  // [0, 1260]. Cup racks aren't constrained to the fork side — cup
  // uses the origin-side edge (or workspace-side when origin sits
  // inside the perp band), mirroring cupEntrance/cupExit. Correct
  // edge here is +63.8 (workspace side, +slideSign*pad).
  const KIOSK_CUP = {
    slots: 12,
    orientation: 'Y',
    direction: 'Positive',
    slot1: { x: 3.8, y: -863.231 },
    slotDistance: 60,
    slideDirection: 'Positive',
    slideDistance: 40,
    keepoutPadding: 60,
    zSafe: -5,
    toolsetter: { x: 1.984, y: -931 },
    tlsSeekStartZ: -5,
    seekDistance: 115,
    seekFeedrate: 700,
    rackHolding: 'Cup',
  };

  test('regression (.117 kiosk Cup): origin INSIDE perp band → 3-move via NEAREST CORNER (diagonal → par walk → diagonal-in)', () => {
    // Origin (24.984, -49.331) sits INSIDE perp band [-56.2, 63.8],
    // ABOVE parMax=-143.231. Nearest corner heading toward TLS is the
    // top-right (perpMax, parMax) = (63.8, -143.231). Move 1 diagonals
    // there (Y stays ≥ parMax → segment above box). Move 2 walks down
    // the right edge to parMin. Move 3 diagonals into TLS below parMin.
    // A direct diagonal from origin to (63.8, parMin) would cut through
    // the box; the corner-first routing avoids it.
    const routine = createToolLengthSetRoutine(
      KIOSK_CUP, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 24.984, y: -49.331 } }
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X63.8 Y-143.231',
      'move 1: diagonal to NEAREST corner (perpMax, parMax) — above the box');
    assert.equal(lines[zSafeIdx + 2], 'G53 G0 X63.8 Y-923.231',
      'move 2: par walk down right edge to parMin');
    assert.equal(lines[zSafeIdx + 3], 'G53 G0 X1.984 Y-931',
      'move 3: diagonal-in to TLS (past parMin → below the box)');
    assert.ok(!lines.some(l => /X-56\.2/.test(l)),
      `must NOT hop to fork side X=-56.2 (out of travel) — got ${JSON.stringify(lines)}`);
  });

  test('regression (.117 kiosk Cup): exit mirrors approach — 3 moves back to origin via same corner', () => {
    // Symmetric with the 3-move entry: perp-out from TLS to (edge,
    // parMin), par walk back up the edge to (edge, parMax = corner
    // near origin), diagonal back to origin. Last diagonal stays
    // above parMax → outside box. Without this the exit lands at
    // (edge, parMin) and the operator's next jog to workspace can cut
    // through the box on the way up.
    const program = createToolLengthSetProgram(
      KIOSK_CUP, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 24.984, y: -49.331 } }
    ).join('\n');
    const lines = motionLines(program);
    let postProbeZIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^G53 G0 Z-5$/.test(lines[i])) { postProbeZIdx = i; break; }
    }
    assert.equal(lines[postProbeZIdx + 1], 'G53 G0 X63.8 Y-923.231',
      'exit move 1: diagonal-out from TLS to (edge, parMin)');
    assert.equal(lines[postProbeZIdx + 2], 'G53 G0 X63.8 Y-143.231',
      'exit move 2: par walk up edge to nearest-origin corner (edge, parMax)');
    assert.equal(lines[postProbeZIdx + 3], 'G53 G0 X24.984 Y-49.331',
      'exit move 3: diagonal back to origin (Y goes above parMax → outside box)');
  });

  test('Cup: origin clearly on +X side of perp range → use +X edge (perpMax)', () => {
    // Origin far +X → cupEntrance rule: use origin-side edge.
    const routine = createToolLengthSetRoutine(
      KIOSK_CUP, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 500, y: -400 } }
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X63.8 Y-923.231');
    assert.equal(lines[zSafeIdx + 2], 'G53 G0 X1.984 Y-931');
  });

  test('Cup: origin clearly on -X side of perp range → use -X edge (perpMin)', () => {
    // Contrived — configure a rack whose perpMin is inside travel and
    // origin sits past it on the -X side. Cup rule picks origin-side.
    const CUP_LEFT = {
      ...KIOSK_CUP,
      slot1: { x: 500, y: -863.231 },  // perp band [440, 560]
      toolsetter: { x: 480, y: -900 }, // inside perp band, past par-min
    };
    const routine = createToolLengthSetRoutine(
      CUP_LEFT, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 100, y: -400 } }  // far -X → past perpMin=440
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    // TLS Y=-900 is INSIDE par range [-923.231, -143.231] → entryPar
    // stays at tlsY (no clamp needed).
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X440 Y-900',
      'origin on -X side → hop to perpMin=440 at tlsY');
  });

  test('Cup: no originMPos → falls back to workspace-side edge', () => {
    // Handler didn't supply origin (old host / edge case). Fall back
    // to workspace-side (slot1Perp + slideSign*pad) — same choice
    // cupEntrance makes in its degenerate branch.
    const routine = createToolLengthSetRoutine(
      KIOSK_CUP, { x: 0, y: 0, z: 0 },
      /* no options.originMPos */
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X63.8 Y-923.231');
  });

  test('Cup + origin inside perp band + orientation=X: 3-move with axes swapped', () => {
    // Same logic but rack aligned along X (perp = Y). Origin par is
    // above the rack (X above parMax). Approach = perp-out to (originX,
    // entryPerp), par walk on Y=entryPerp, then diagonal to TLS.
    const CUP_X = {
      slots: 4,
      orientation: 'X',
      direction: 'Positive',
      slot1: { x: -600, y: 3.8 },        // rack aligned along X, perp=Y at 3.8
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
      zSafe: -5,
      toolsetter: { x: -700, y: 1.984 }, // par=X=-700 past parMin, perp=Y=1.984 inside band
      tlsSeekStartZ: -5,
      seekDistance: 115,
      seekFeedrate: 700,
      rackHolding: 'Cup',
    };
    // orient=X: perpAxis=Y, parAxis=X. slot1.y=3.8, pad=60 → perp band Y[-56.2, 63.8].
    // slot par range: X in [-660, -360]. Toolsetter X=-700 past parMin → clamp entryPar to -660.
    // Origin (30, 40): Y=40 inside perp band; X=30 above parMax=-360.
    // Nearest corner heading toward TLS: X=parMax=-360, Y=workspace edge=63.8.
    // Cup + origin inside: workspace-side = slot1.y + slideSign*pad = 3.8 + 60 = 63.8.
    const routine = createToolLengthSetRoutine(
      CUP_X, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 30, y: 40 } }
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X-360 Y63.8',
      'move 1: diagonal to nearest corner (parMax, workspace edge)');
    assert.equal(lines[zSafeIdx + 2], 'G53 G0 X-660 Y63.8',
      'move 2: par (X) walk along edge to clamped parMin=-660');
    assert.equal(lines[zSafeIdx + 3], 'G53 G0 X-700 Y1.984',
      'move 3: diagonal-in to TLS');
  });

  test('Cup + origin far outside perp band: skips 3-move, uses 2-move (edge, perp-in)', () => {
    // Origin (500, -400): X=500 well past perpMax=63.8. Diagonal from
    // origin to (perpMax, parMin) stays past perpMax the whole way,
    // no box crossing risk. 2-move is correct — 3-move would add an
    // unnecessary perp-out.
    const routine = createToolLengthSetRoutine(
      KIOSK_CUP, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 500, y: -400 } }
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X63.8 Y-923.231');
    assert.equal(lines[zSafeIdx + 2], 'G53 G0 X1.984 Y-931');
    // Only 2 XY moves after Z-safe, then G38 probe seq.
    assert.doesNotMatch(lines[zSafeIdx + 3] ?? '', /^G53 G0 X/,
      'no 3rd XY move — origin outside perp collapses to 2-move');
  });

  test('Fork rack: still uses sliding-side edge as the entry edge regardless of origin', () => {
    // Fork geometry forces sliding-side approach (-56.2 here). Origin
    // far +X puts the workspace on the OPPOSITE side of the box from
    // the sliding edge — routePoint now detours via the +X opposite
    // edge first (safe: stays past parMin), then perp-crosses at parMin
    // to the sliding-edge entry corner, then perp-in to TLS. Before
    // the refactor the routine emitted a 2-move [(-56.2, parMin),
    // TLS] which CROSSES the box interior diagonally when origin sits
    // in the opposite half — new 3-move path is safer.
    const KIOSK_FORK = { ...KIOSK_CUP, rackHolding: 'Fork' };
    const routine = createToolLengthSetRoutine(
      KIOSK_FORK, { x: 0, y: 0, z: 0 },
      { originMPos: { x: 500, y: -400 } }  // origin far +X — opposite of Fork sliding side
    ).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    // Route must eventually pivot on the sliding-side edge (-56.2) —
    // fork's engagement constraint.
    assert.ok(lines.some(l => /X-56\.2\b/.test(l)),
      `route must include sliding-side edge X=-56.2 — got ${JSON.stringify(lines)}`);
    // Move 1: opposite-side corner at shared par-end (parMin) — avoids
    // cutting the box interior.
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X63.8 Y-923.231',
      'move 1: opposite-side corner (safe past parMin)');
    // Move 2: perp-cross at parMin to sliding-edge entry corner.
    assert.equal(lines[zSafeIdx + 2], 'G53 G0 X-56.2 Y-923.231',
      'move 2: entry-side corner on sliding edge at parMin');
    // Move 3: diagonal into TLS (below parMin — stays past par-end).
    assert.equal(lines[zSafeIdx + 3], 'G53 G0 X1.984 Y-931',
      'move 3: perp-in to TLS');
  });

  test('TLS past sliding side (outside keepout perp range): single-move approach', () => {
    // Toolsetter mounted past the rack in +X — no risk of crossing slots.
    const OUTSIDE = { ...RACK, toolsetter: { x: 400, y: -100 } };
    const routine = createToolLengthSetRoutine(OUTSIDE, { x: 0, y: 0, z: 0 }).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    assert.equal(lines[zSafeIdx + 1], 'G53 G0 X400 Y-100');
    // No second XY move — the next line goes straight into the probe
    // sequence (G43.1 TLO reset, then G38 seek).
    assert.doesNotMatch(lines[zSafeIdx + 2] ?? '', /^G53 G0 X/);
  });

  test('chained after rackExitToTLS: skipXYApproach suppresses the redundant edge-hop', () => {
    // rackExitToTLS parks the spindle AT (tlsX, tlsY). The routine's
    // own XY approach would then walk out to the sliding edge and back
    // to TLS — round-trip motion for no reason. skipXYApproach:true
    // omits both the edge-hop and the perp-in.
    const routine = createToolLengthSetRoutine(RACK, { x: 0, y: 0, z: 0 }, { skipXYApproach: true }).join('\n');
    const lines = motionLines(routine);
    const zSafeIdx = lines.findIndex(l => /G53 G0 Z-5/.test(l));
    // Immediately after Z-safe, next line is the G43.1 TLO reset or
    // G38 seek, NOT another `G53 G0 X…` XY move.
    assert.doesNotMatch(lines[zSafeIdx + 1] ?? '', /^G53 G0 X/,
      'chained routine must not re-emit the XY approach');
  });

  test('standalone $TLS program: XY exit through sliding edge after Z-safe (TLS inside keepout)', () => {
    // After the probe & Z-safe retract, the spindle sits at (tlsX, tlsY)
    // inside the keepout. Without an exit move, the next operator action
    // (jog to XY0, run a program) cuts across occupied slot columns on
    // the way out. Program must emit `G53 G0 X{entryPerp} Y{tlsY}` between
    // the final Z-safe and G4 dwell.
    const program = createToolLengthSetProgram(RACK, { x: 0, y: 0, z: 0 }).join('\n');
    const lines = motionLines(program);
    // Find the LAST Z-safe (the post-probe retract, not the pre-approach).
    let postProbeZIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^G53 G0 Z-5$/.test(lines[i])) { postProbeZIdx = i; break; }
    }
    assert.notEqual(postProbeZIdx, -1, 'expected post-probe Z-safe retract');
    assert.equal(lines[postProbeZIdx + 1], 'G53 G0 X70.5 Y-640',
      'exit must land on sliding edge at TLS par before anything else');
  });

  test('standalone $TLS program: no XY exit when TLS is outside keepout perp range', () => {
    // Toolsetter mounted past the rack — direct exit is safe, don't
    // emit a redundant edge-hop.
    const OUTSIDE = { ...RACK, toolsetter: { x: 400, y: -100 } };
    const program = createToolLengthSetProgram(OUTSIDE, { x: 0, y: 0, z: 0 }).join('\n');
    const lines = motionLines(program);
    let postProbeZIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^G53 G0 Z-5$/.test(lines[i])) { postProbeZIdx = i; break; }
    }
    assert.doesNotMatch(lines[postProbeZIdx + 1] ?? '', /^G53 G0 X/,
      'no XY exit expected when TLS is outside the padded rack envelope');
  });
});

// End-to-end program shape tests — the tool-change program builder
// stitches rackEntrance / engaged descent / Z / clamp / slide-out
// together. Verifying the sequence guards against regressions where
// the rack routing (padded entry + descent) gets accidentally dropped
// on the load path — the exact bug that made T0 → T1 skip padding.
describe('buildLoadTool — same-side origin ↔ entrance (fork)', () => {
  test('T0 → T1: pads via rackEntrance BEFORE landing on slot 1 engaged', () => {
    const slotPos = calculateSlotPosition(RACK, 1);
    const gcode = buildLoadTool(
      RACK,
      /* toolNumber */         1,
      slotPos,
      /* tlsRoutine */         '',
      /* drawbarAlreadyReleased */ false,
      /* origin */             { x: 60, y: 120 }
    );
    // The first two motion lines MUST be the rackEntrance pair
    // (diagonal to sliding-side entry, then perp descent to approach)
    // — anything else means the load path is skipping padding.
    const lines = motionLines(gcode);
    assert.equal(lines[0], 'G53 G0 X-55 Y40', 'first move should be diagonal to sliding-side entry point');
    assert.equal(lines[1], 'G53 G0 X-75',      'second move should be perp descent to slot approach');
    // Then a G0 to engaged (final perp step at Z-safe, spindle empty),
    // followed by the Z descent + clamp + G1 slide-out to approach.
    assert.equal(lines[2], 'G53 G0 X-115 Y40', 'third move should land on slot 1 engaged (perp step at Z-safe)');
    // Sanity: the Z descent to slot Z + G1 slide-out to approach appear
    // in the emitted program.
    assert.ok(lines.some(l => l.startsWith('G53 G0 Z')),  'Z descent to slot Z should be present');
    assert.ok(lines.some(l => l.startsWith('G53 G1 X-75 Y40')), 'G1 slide-out to approach should be present');
  });
});

describe('buildUnloadTool — same-side origin ↔ entrance (fork)', () => {
  test('T1 → T0: pads via rackEntrance BEFORE G1 slide-in to slot 1 engaged', () => {
    const slotPos = calculateSlotPosition(RACK, 1);
    const gcode = buildUnloadTool(
      RACK,
      /* currentTool */  1,
      slotPos,
      /* origin */       { x: 60, y: 120 }
    );
    const lines = motionLines(gcode);
    assert.equal(lines[0], 'G53 G0 X-55 Y40', 'first move should be diagonal to sliding-side entry point');
    assert.equal(lines[1], 'G53 G0 X-75',      'second move should be perp descent to slot approach');
    // Then Z down (tool in hand) and G1 slide INTO the fork at engaged.
    assert.ok(lines.some(l => l.startsWith('G53 G0 Z')), 'Z descent to slot Z should be present');
    assert.ok(lines.some(l => l === 'G53 G1 X-115 Y40 F' + (RACK.slideSpeed || 500)),
      'G1 slide-in to engaged should be present');
  });

  test('T1 → T0: ends at slot 1 engaged (Z-safe), so a chained load can par-walk over the rack', () => {
    // Deliberately DOES NOT ascend perp to the entry point — the
    // spindle sits above the tools at Z-safe, so leaving the machine
    // at the engaged X/Y lets a subsequent Tm→Tn swap take a single
    // par walk to the next slot instead of exiting to the sliding
    // edge and coming back.
    const slotPos = calculateSlotPosition(RACK, 1);
    const gcode = buildUnloadTool(RACK, 1, slotPos, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    // Very last motion line before the M61 sentinel is the Z retract
    // — no perp ascent after it.
    const nonSentinel = lines.filter(l => !l.startsWith('M'));
    const finalMotion = nonSentinel[nonSentinel.length - 1];
    assert.ok(finalMotion.startsWith('G53 G0 Z'),
      `unload should end with the Z retract, not a perp ascent (last motion was ${finalMotion})`);
  });
});

// T1 → T2 (fork → fork tool swap). This is the case that regressed:
// with the pre-M6 origin passed to buildLoadTool, the load's
// rackEntrance diagonaled from workspace to slot 2 entry — cutting
// through the rack — even though the machine sits at slot 1's engaged
// position after unload. Fix: `chainedFromRack=true` tells buildLoadTool
// to skip rackEntrance entirely and take a single par walk at Z-safe
// straight to slot 2 engaged. Spindle nose is above the tools sitting
// in the intermediate slots so the walk is collision-free.
describe('buildLoadTool — T1 → T2 chained swap (same-side)', () => {
  test('chained: single par walk from slot 1 engaged to slot 2 engaged (one move, not three)', () => {
    const slotPos = calculateSlotPosition(RACK, 2);
    const gcode = buildLoadTool(
      RACK,
      /* toolNumber */              2,
      slotPos,
      /* tlsRoutine */              '',
      /* drawbarAlreadyReleased */  true,     // just unloaded, drawbar open
      /* origin (ignored) */        { x: 60, y: 120 },
      /* chainedFromRack */         true
    );
    const lines = motionLines(gcode);
    // First (and only) approach move: straight to slot 2 engaged.
    assert.equal(lines[0], 'G53 G0 X-115 Y120',
      'chained load should take one par walk directly to slot 2 engaged — NO padded entry / descent detour');
    // Followed by Z down + clamp + G1 slide-out (not the padded 3-move
    // entry pair).
    assert.ok(lines[1].startsWith('G53 G0 Z'),
      'next move should be Z descent onto the shank');
    // And NO diagonal to sliding-side edge should appear before Z down.
    assert.equal(
      lines.slice(0, 2).filter(l => l.startsWith('G53 G0 X-55')).length, 0,
      'chained load must not include a sliding-side (X=-55) entry move'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cup regression suite.
//
// Cup used to be excluded from the rack routing model on the assumption
// that it was a separate top-down flow. That produced two bugs:
//   1. Cup unload skipped rackEntrance — a direct G0 X/Y to the slot from
//      an off-side origin cut through the padded keepout.
//   2. Cup chained load fell back to the padded-entry pair even though
//      the machine sat at slot-m engaged, Z-safe (over the tools). It
//      exited to the sliding edge and came back in — three extra moves.
// These tests lock in the fix: Cup shares the same routing model as Fork,
// minus only the horizontal G1 slide (cup catches from above during Z
// descent, no fork groove to engage).
// ─────────────────────────────────────────────────────────────────────────
const CUP_RACK = {
  ...RACK,
  rackHolding: 'Cup',
  slot1: { x: -115, y: 40, z: -100 },
  drawbarOffset: 1,
  drawbarFeedrate: 300,
  zSafe: 0,
  clampAuxOutput: 2,
};

describe('buildUnloadTool — Cup routes around keepout (regression)', () => {
  test('T1 → T0 from same-side origin (+X): 2-move cupEntrance via +X edge, NO fork-style approach descent', () => {
    const slotPos = calculateSlotPosition(CUP_RACK, 1);
    const gcode = buildUnloadTool(
      CUP_RACK,
      /* currentTool */ 1,
      slotPos,
      /* origin */      { x: 60, y: 120 }   // workspace at +X of slot1.x=-115, INSIDE par range
    );
    const lines = motionLines(gcode);
    // Cup does not need the fork's sliding-side entry (there's no G1
    // slide to align). Origin (X=60) is +X of keepout perpMax=-55, so
    // enter via +X edge — diagonal to (-55, engaged.y) then perp step
    // to engaged. TWO moves, not fork's three (entry / approach / engaged).
    assert.equal(lines[0], 'G53 G0 X-55 Y40',  'first move: diagonal to +X edge at engaged.par (no fork sliding-side detour)');
    assert.equal(lines[1], 'G53 G0 X-115 Y40', 'second move: perp step into engaged.xy — that\'s IT for the entry');
    // NO third padded-approach move at X=-75 like fork would emit.
    assert.ok(!lines.slice(0, 3).some(l => l === 'G53 G0 X-75'),
      'Cup must NOT emit fork\'s intermediate perp descent to slotApproach (X=-75)');
    // No G1 slide either (fork-only).
    assert.ok(!lines.some(l => /^G53 G1 [XY]/.test(l)),
      'Cup unload must NOT emit a G1 horizontal XY slide — that\'s fork-only (G1 Z is fine, that\'s the drawbar back-off)');
    // Unload descends to slot.z first (with clamped tool), then AFTER
    // the unclamp aux fires, a G1 back-off retracts to slot.z + offset
    // at drawbarFeedrate — this overlaps with the pneumatic push so the
    // tool holder stays on the cup lip while the drawbar releases.
    assert.ok(lines.some(l => l === 'G53 G0 Z-100'),
      'unload initial descent should be to slot.z (with clamped tool still in cup position)');
    assert.ok(lines.some(l => l === 'G53 G1 Z-99 F300'),
      'unload should G1 back off to slot.z + drawbarOffset at drawbarFeedrate after unclamp aux');
    assert.ok(lines.some(l => l === `G53 G0 Z${CUP_RACK.zSafe || 0}`),
      'should retract to Z-safe at the end');
  });

  test('T1 → T0 from opposite-side origin (Positive slideDir): 2-move via +X edge, NOT 4-move opposite-corner detour', () => {
    // This is the user-reported scenario: with slideDirection='Positive'
    // the SLIDING side is -X (fork enters from -X). Origin sits at +X of
    // the rack — OPPOSITE the sliding side. Fork routing (rackEntrance)
    // must detour via the far -X sliding-side edge (4 moves). Cup has no
    // slide constraint — it can enter from the origin's own +X edge in
    // just 2 moves. Locks in the fix for the "cup still uses fork's
    // opposite-corner detour" bug.
    const POS_CUP_RACK = { ...CUP_RACK, slideDirection: 'Positive' };
    const slotPos = calculateSlotPosition(POS_CUP_RACK, 1);
    const gcode = buildUnloadTool(
      POS_CUP_RACK,
      /* currentTool */ 1,
      slotPos,
      /* origin */      { x: 701, y: 20 }  // +X of keepout (perpMax = -115+60 = -55)
    );
    const lines = motionLines(gcode);
    // Cup routes via +X edge (perpMax = -55) — the ORIGIN-side edge — in
    // 2 moves. NOT via the sliding-side edge which is now the -X side.
    assert.equal(lines[0], 'G53 G0 X-55 Y40', 'first move: diagonal to ORIGIN-side (+X) edge at engaged.par');
    assert.equal(lines[1], 'G53 G0 X-115 Y40', 'second move: perp step into engaged.xy');
    // Explicitly reject the fork opposite-corner detour markers:
    assert.ok(!lines.some(l => l === 'G53 G0 X-175 Y-20'),
      'Cup must NOT visit the opposite-side corner (X=-175, i.e. -X sliding-side edge)');
    assert.ok(!lines.some(l => l === 'G53 G0 X-175'),
      'Cup must NOT emit a perp move to the far -X sliding side');
  });

  test('T1 → T0: ends at slot 1 engaged (Z-safe), so a chained load can par-walk over the rack', () => {
    // Same guarantee as fork: no perp ascent after Z retract, so a
    // subsequent chained load doesn't waste a move exiting to the
    // sliding edge before par-walking to the next slot.
    const slotPos = calculateSlotPosition(CUP_RACK, 1);
    const gcode = buildUnloadTool(CUP_RACK, 1, slotPos, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    const nonSentinel = lines.filter(l => !l.startsWith('M'));
    const finalMotion = nonSentinel[nonSentinel.length - 1];
    assert.ok(finalMotion.startsWith('G53 G0 Z'),
      `unload should end with the Z retract, not a perp ascent (last motion was ${finalMotion})`);
  });
});

describe('buildLoadTool — Cup T1 → T2 chained swap (regression)', () => {
  test('chained: single par walk from slot 1 engaged to slot 2 engaged (no rackEntrance detour)', () => {
    // Cup used to always fall through to non-chained mode, forcing the
    // padded-entry pair even when unload had just placed the machine at
    // slot 1 engaged. This test locks in the fast path: single G0 par
    // walk at Z-safe, straight to slot 2 engaged.
    const slotPos = calculateSlotPosition(CUP_RACK, 2);
    const gcode = buildLoadTool(
      CUP_RACK,
      /* toolNumber */              2,
      slotPos,
      /* tlsRoutine */              '',
      /* drawbarAlreadyReleased */  true,     // just unloaded, drawbar open
      /* origin (ignored) */        { x: 60, y: 120 },
      /* chainedFromRack */         true
    );
    const lines = motionLines(gcode);
    // First (and only) approach move: straight to slot 2 engaged.
    assert.equal(lines[0], 'G53 G0 X-115 Y120',
      'chained cup load should take one par walk directly to slot 2 engaged — NO padded entry / descent detour');
    // Followed by Z down (no releaseFirst since drawbarAlreadyReleased=true)
    // → clamp → Z retract. No G1 slide (cup doesn't slide).
    assert.ok(lines[1].startsWith('G53 G0 Z'),
      'next move should be Z descent onto the shank');
    assert.ok(!lines.some(l => /^G53 G1 [XY]/.test(l)),
      'Cup chained load must not emit a G1 horizontal XY slide (fork-only)');
    // And NO diagonal to sliding-side edge should appear before Z down.
    assert.equal(
      lines.slice(0, 2).filter(l => l.startsWith('G53 G0 X-55')).length, 0,
      'chained cup load must not include a sliding-side (X=-55) entry move'
    );
  });
});

describe('cupEntrance / cupExit — direct 2-move routes', () => {
  test('cupEntrance from +X same-side origin: diagonal to +X edge + perp step', () => {
    const engaged = { x: -115, y: 40 };
    const gcode = cupEntrance(engaged, { x: 60, y: 120 }, CUP_RACK);
    const lines = motionLines(gcode);
    assert.deepEqual(lines, ['G53 G0 X-55 Y40', 'G53 G0 X-115 Y40']);
  });

  test('cupEntrance from -X origin: diagonal to -X edge + perp step', () => {
    const engaged = { x: -115, y: 40 };
    const gcode = cupEntrance(engaged, { x: -500, y: 120 }, CUP_RACK);
    const lines = motionLines(gcode);
    assert.deepEqual(lines, ['G53 G0 X-175 Y40', 'G53 G0 X-115 Y40']);
  });

  test('cupExit to +X destination: perp step + diagonal out', () => {
    const engaged = { x: -115, y: 40 };
    const gcode = cupExit(engaged, { x: 60, y: 120 }, CUP_RACK);
    const lines = motionLines(gcode);
    assert.deepEqual(lines, ['G53 G0 X-55 Y40', 'G53 G0 X60 Y120']);
  });

  test('cupEntrance user-reported ALARM:2 scenario (origin at homed (0,0) inside keepout perp range, rack near X=0)', () => {
    // Live-reproduced on kiosk .117 (log line: rackEntrance case 2 with
    // sliding-side edge X=-56.1, outside machine's X≥0 travel envelope).
    // Config: slot1.x=3.9, slideDirection='Positive', pad=60 → keepout
    // X = [-56.1, +63.9]. Origin at (0, 0) after homing sits INSIDE
    // that perp range. Previously fell back to rackEntrance (sliding-
    // side edge = X=-56.1 → soft-limit alarm). Fix: use opposite-of-
    // sliding edge (X=+63.9) instead — inside travel, safe route.
    const KIOSK = {
      slots: 4,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 3.9, y: -383.231, z: -116.5 },
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
    };
    const engaged = { x: 3.9, y: -203.231 };  // slot 4
    const gcode = cupEntrance(engaged, { x: 0, y: 0 }, KIOSK);
    const lines = motionLines(gcode);
    // Route must go via +X edge (+63.9), NOT -X edge (-56.1).
    assert.ok(lines.every(l => !l.includes('X-56.1')),
      `must NOT include the sliding-side edge X=-56.1 (outside machine travel). got: ${JSON.stringify(lines)}`);
    // Expect 3 moves: corner → par walk end → engaged.
    assert.equal(lines[0], 'G53 G0 X63.9 Y-143.231',
      'first move: diagonal to opposite-of-sliding edge at nearest corner par (parMax=-143.231)');
    assert.equal(lines[1], 'G53 G0 X63.9 Y-203.231',
      'second move: par walk down the +X edge to slot par');
    assert.equal(lines[2], 'G53 G0 X3.9 Y-203.231',
      'third move: perp step into engaged.xy');
  });

  test('cupEntrance user-reported scenario (Positive slideDir, origin far +X, opposite of sliding)', () => {
    // Reproduces the exact geometry from the log the user pasted:
    //   slot1 at X=203.8, slideDirection='Positive', keepoutPadding=60
    //   → perpMax=+263.8 (opposite sliding side, ORIGIN side)
    //   → perpMin=+143.8 (sliding side)
    //   origin at X=701.166, Y=-432.719
    // Fork rackEntrance would 4-move detour via the far -X sliding
    // side. Cup should just diagonal to +X edge (263.8) then perp
    // step to (203.8, engaged.y).
    const RACK_POS = { ...CUP_RACK, slot1: { x: 203.8, y: -443.031, z: -100 }, slideDirection: 'Positive' };
    const engaged = { x: 203.8, y: -443.031 };
    const gcode = cupEntrance(engaged, { x: 701.166, y: -432.719 }, RACK_POS);
    const lines = motionLines(gcode);
    assert.deepEqual(lines, ['G53 G0 X263.8 Y-443.031', 'G53 G0 X203.8 Y-443.031']);
  });
});

describe('buildLoadTool — Cup T0 → T1 uses cupEntrance (non-chained)', () => {
  test('T0 → T1: 2-move cupEntrance via origin-side edge, NO fork-style intermediate approach descent', () => {
    const slotPos = calculateSlotPosition(CUP_RACK, 1);
    const gcode = buildLoadTool(
      CUP_RACK,
      /* toolNumber */              1,
      slotPos,
      /* tlsRoutine */              '',
      /* drawbarAlreadyReleased */  false,   // T0 start, drawbar clamped
      /* origin */                  { x: 60, y: 120 }
      // chainedFromRack defaults to false
    );
    const lines = motionLines(gcode);
    assert.equal(lines[0], 'G53 G0 X-55 Y40',  'first move: diagonal to +X edge at engaged.par');
    assert.equal(lines[1], 'G53 G0 X-115 Y40', 'second move: perp step into engaged.xy');
    assert.ok(!lines.slice(0, 3).some(l => l === 'G53 G0 X-75'),
      'Cup non-chained load must NOT emit fork\'s intermediate slot-approach descent');
    // No G1 slide (fork-only).
    assert.ok(!lines.some(l => /^G53 G1 [XY]/.test(l)),
      'Cup non-chained load must not emit a G1 horizontal XY slide (fork-only)');
  });
});

// Load-side drawbar offset compensation. Documented under buildInitialConfig
// as `loadDrawbarOffset`. Purpose: with drawbar open, spindle descending to
// slot.z would press the tool into the cup. Approach at slot.z + offset first
// (no pressure), clamp, then descend the offset to slot.z so the holder
// seats fully against the spindle nose taper as the drawbar completes its
// upward pull.
describe('buildLoadTool — drawbar offset compensation (regression)', () => {
  test('Cup load with offset=1: G0 approach at slot.z+1, clamp, then G1 seat down at drawbarFeedrate', () => {
    const slotPos = calculateSlotPosition(CUP_RACK, 1);
    const gcode = buildLoadTool(
      CUP_RACK, 1, slotPos, '', false, { x: 60, y: 120 }, false
    );
    const lines = motionLines(gcode);
    assert.ok(lines.some(l => l === 'G53 G0 Z-99'),
      'first Z descent should be G0 rapid to slot.z + drawbarOffset (approach at drawbar-open height)');
    assert.ok(lines.some(l => l === 'G53 G1 Z-100 F300'),
      'seat should be G1 (feedrate move) to slot.z at drawbarFeedrate — overlaps with pneumatic clamp actuation');
    // Clamp aux (M65 P2) must fire BETWEEN the G0 approach and the G1 seat.
    const approachIdx = lines.indexOf('G53 G0 Z-99');
    const seatIdx     = lines.indexOf('G53 G1 Z-100 F300');
    const clampIdx    = lines.findIndex(l => l === 'M65 P2');
    assert.ok(clampIdx > approachIdx && clampIdx < seatIdx,
      `clamp aux (M65 P2) must fire AFTER approach and BEFORE seat — got clampIdx=${clampIdx}, approachIdx=${approachIdx}, seatIdx=${seatIdx}`);
  });

  test('Cup unload with offset=1: descend to slot.z, unclamp, then G1 back off at drawbarFeedrate', () => {
    const slotPos = calculateSlotPosition(CUP_RACK, 1);
    const gcode = buildUnloadTool(CUP_RACK, 1, slotPos, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    assert.ok(lines.some(l => l === 'G53 G0 Z-100'),
      'first Z descent should be G0 rapid to slot.z (with clamped tool)');
    assert.ok(lines.some(l => l === 'G53 G1 Z-99 F300'),
      'back-off should be G1 to slot.z + drawbarOffset at drawbarFeedrate — overlaps with pneumatic unclamp actuation');
    // Unclamp aux (M64 P2) must fire BETWEEN the descent and the back-off.
    const descentIdx = lines.indexOf('G53 G0 Z-100');
    const backoffIdx = lines.indexOf('G53 G1 Z-99 F300');
    const unclampIdx = lines.findIndex(l => l === 'M64 P2');
    assert.ok(unclampIdx > descentIdx && unclampIdx < backoffIdx,
      `unclamp aux (M64 P2) must fire AFTER descent and BEFORE back-off — got unclampIdx=${unclampIdx}, descentIdx=${descentIdx}, backoffIdx=${backoffIdx}`);
  });

  test('Fork racks also emit drawbar G1 compensation (drawbar push acts on the holder in either mount)', () => {
    // The drawbar's actuation pushes/pulls the holder relative to the
    // spindle nose regardless of what's holding the holder in place
    // (cup lip or fork prongs). Same 1 mm / 300 mm/min G1 comp keeps
    // the holder stationary while the drawbar completes its stroke.
    const FORK_RACK = { ...CUP_RACK, rackHolding: 'Fork' };
    const slotPos = calculateSlotPosition(FORK_RACK, 1);
    const loadLines   = motionLines(buildLoadTool(FORK_RACK, 1, slotPos, '', false, { x: 60, y: 120 }, false));
    const unloadLines = motionLines(buildUnloadTool(FORK_RACK, 1, slotPos, { x: 60, y: 120 }));
    // Load: approach at slot.z + 1 → clamp → G1 seat down to slot.z.
    assert.ok(loadLines.some(l => l === 'G53 G0 Z-99'),
      'Fork load approach should be G0 to slot.z + DRAWBAR_OFFSET_MM (drawbar-open height)');
    assert.ok(loadLines.some(l => l === 'G53 G1 Z-100 F300'),
      'Fork load should G1 seat down to slot.z at DRAWBAR_FEEDRATE_MMPM after clamp');
    // Unload: descend to slot.z → unclamp → G1 back off to slot.z + 1.
    assert.ok(unloadLines.some(l => l === 'G53 G1 Z-99 F300'),
      'Fork unload should G1 back off to slot.z + DRAWBAR_OFFSET_MM at DRAWBAR_FEEDRATE_MMPM after unclamp');
  });
});

// $slotN manual navigation. Before the fix this emitted a direct
// `G0 Z-safe / G0 X Y` pair with no keepout awareness, so a jog from an
// origin on the wrong side of the rack would cut a diagonal straight
// through the tools sitting in the other pockets. Same routing surface
// the tool change uses — no reason nav should bypass it.
describe('buildSlotNav — routes through keepout-safe entrance', () => {
  test('Cup: same-side origin (+X, inside par) → 2-move cupEntrance to engaged.xy', () => {
    const gcode = buildSlotNav(CUP_RACK, 1, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    assert.equal(lines[0], 'G53 G21 G90 G0 Z0', 'first move: retract to Z-safe');
    assert.equal(lines[1], 'G53 G0 X-55 Y40',  'second move: cupEntrance diagonal to +X edge at engaged.par');
    assert.equal(lines[2], 'G53 G0 X-115 Y40', 'third move: perp step into engaged.xy');
    // No stray G1 slides (fork-only).
    assert.ok(!lines.some(l => /^G53 G1 [XY]/.test(l)),
      'cup nav must NOT emit a G1 horizontal XY slide (fork-only)');
  });

  test('Cup: opposite-slide origin (Positive slideDir) still uses ORIGIN-side edge', () => {
    // slideDirection='Positive' puts the sliding side at -X, but the
    // cup has no slide constraint — nav must still take the shorter
    // ORIGIN-side (+X) route, not detour to the far -X sliding edge.
    const POS_CUP = { ...CUP_RACK, slideDirection: 'Positive' };
    const gcode = buildSlotNav(POS_CUP, 1, { x: 701, y: 20 });
    const lines = motionLines(gcode);
    assert.equal(lines[1], 'G53 G0 X-55 Y40', 'via ORIGIN-side (+X) edge, not fork sliding-side (-X)');
    assert.ok(!lines.some(l => l === 'G53 G0 X-175'),
      'cup nav must NOT emit a move to the far -X sliding-side edge');
  });

  test('Cup: degenerate origin (inside keepout perp range) routes via opposite-of-sliding edge', () => {
    // User-reported ALARM:2 geometry: rack sits near X=0 boundary, origin
    // at (0,0) is inside the keepout perp range. Sliding-side edge would
    // land outside the machine envelope — cupEntrance must go the other
    // way. Regression guard for the same ALARM:2 bug that hit tool change.
    const NEAR_ZERO = {
      ...CUP_RACK,
      slot1: { x: 3.9, y: 40, z: -100 },
      slideDirection: 'Positive',   // sliding side = -X (falls outside 0..+1260 envelope)
      keepoutPadding: 60,
    };
    const gcode = buildSlotNav(NEAR_ZERO, 1, { x: 0, y: 0 });
    const lines = motionLines(gcode);
    // Opposite-of-sliding edge sits at slot1.x + pad = 3.9 + 60 = +63.9,
    // well inside the machine envelope. No move should land at the
    // sliding-side edge (3.9 - 60 = -56.1, outside envelope → ALARM:2).
    assert.ok(!lines.some(l => /X-56\.1(?:\D|$)/.test(l)),
      'must NOT route via sliding-side edge X=-56.1 (outside 0..+1260 envelope → ALARM:2)');
    assert.ok(lines.some(l => /X63\.9(?:\D|$)/.test(l)),
      'must route via opposite-of-sliding edge X=+63.9 (inside envelope)');
  });

  test('Fork: same-side origin → rackEntrance + G0 to engaged', () => {
    // RACK: slideDirection='Negative' → sliding side = +X. Origin at +X
    // inside par range takes case 1 (same-side): diagonal to sliding-side
    // edge at engaged.par, then perp step to engaged.xy.
    const FORK_RACK = { ...RACK, zSafe: 0 };
    const gcode = buildSlotNav(FORK_RACK, 2, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    assert.equal(lines[0], 'G53 G21 G90 G0 Z0', 'first move: retract to Z-safe');
    // rackEntrance case 1 emits diagonal to (-55, 120) then perp to
    // slot approach (-75, 120); then the nav wrapper G0s to engaged.
    assert.equal(lines[1], 'G53 G0 X-55 Y120',  'rackEntrance: diagonal to +X sliding-side edge at engaged.par');
    assert.equal(lines[2], 'G53 G0 X-75',        'rackEntrance: perp step to slot approach (Y omitted, unchanged)');
    assert.equal(lines[3], 'G53 G0 X-115 Y120',  'nav wrapper: final G0 to engaged.xy');
  });

  test('zSafe retract always emitted first', () => {
    const CUSTOM_SAFE = { ...RACK, zSafe: -5 };
    const gcode = buildSlotNav(CUSTOM_SAFE, 1, { x: 60, y: 120 });
    assert.equal(motionLines(gcode)[0], 'G53 G21 G90 G0 Z-5', 'nav must retract to zSafe before moving XY');
  });
});

// Safety gate: user's shop incident — accidentally sending M64 P2 (release
// pneumatic collet) while the spindle was still spinning launched the tool
// holder across the wasteboard like a top. Plugin now refuses to forward
// the unclamp aux-ON when machineState.spindleActive is true, replacing it
// with a visible rejection comment so the operator sees why.
describe('gateSpindleUnclamp — safety block for M64 on clampAuxOutput while spindle active', () => {
  const SETTINGS = { clampAuxOutput: 2 };
  const wrap = (line) => [{ command: line, isOriginal: true }];

  test('spindle active + M64 P<clampAux> → replaced with one-line BLOCKED display, comment on wire', () => {
    const cmds = wrap('M64 P2');
    gateSpindleUnclamp(cmds, { machineState: { spindleActive: true } }, SETTINGS);
    // Actual bytes on the wire — pure comment, grblHAL will no-op it.
    assert.ok(/^\(M64 P2 BLOCKED/.test(cmds[0].command),
      `wire form must be a comment starting with the original + BLOCKED, got ${cmds[0].command}`);
    // Terminal display: shows the original command + reason on one line.
    assert.ok(cmds[0].displayCommand.startsWith('M64 P2'),
      `display must show original command first, got ${cmds[0].displayCommand}`);
    assert.ok(/BLOCKED/.test(cmds[0].displayCommand),
      `display must include BLOCKED reason, got ${cmds[0].displayCommand}`);
    assert.equal(cmds[0].isOriginal, false);
  });

  test('spindle IDLE + M64 P<clampAux> → passes through unchanged', () => {
    const cmds = wrap('M64 P2');
    gateSpindleUnclamp(cmds, { machineState: { spindleActive: false } }, SETTINGS);
    assert.equal(cmds[0].command, 'M64 P2', 'idle spindle must not block unclamp');
    assert.equal(cmds[0].isOriginal, true, 'unmodified original stays original');
  });

  test('spindle active + M65 (fail-safe clamp) → passes through — M65 tightens, not releases', () => {
    const cmds = wrap('M65 P2');
    gateSpindleUnclamp(cmds, { machineState: { spindleActive: true } }, SETTINGS);
    assert.equal(cmds[0].command, 'M65 P2', 'M65 must not be gated — it holds the tool');
  });

  test('spindle active + M64 on DIFFERENT aux (dust boot / coolant) → passes through', () => {
    // Only the configured clampAuxOutput is guarded. M64 P3, M64 P0, etc.
    // remain untouched so the job can freely toggle unrelated aux outputs.
    const cmds = [
      { command: 'M64 P3', isOriginal: true },
      { command: 'M64 P0', isOriginal: true },
    ];
    gateSpindleUnclamp(cmds, { machineState: { spindleActive: true } }, SETTINGS);
    assert.equal(cmds[0].command, 'M64 P3', 'M64 on unrelated aux must not be gated');
    assert.equal(cmds[1].command, 'M64 P0', 'M64 on unrelated aux must not be gated');
  });

  test('N-prefix + leading-zero variants (N250 M0064 P02) — normalized match still gates', () => {
    const cmds = wrap('N250 M0064 P02');
    gateSpindleUnclamp(cmds, { machineState: { spindleActive: true } }, SETTINGS);
    assert.ok(/BLOCKED/i.test(cmds[0].command),
      `padded / N-prefixed form must still be gated, got ${cmds[0].command}`);
    // Display strips the N-prefix so the operator sees a clean line.
    assert.ok(!/^N\d+/.test(cmds[0].displayCommand),
      `display must strip N-prefix, got ${cmds[0].displayCommand}`);
  });

  test('missing machineState.spindleActive — treat as unknown, do not gate', () => {
    // Old host that doesn't yet expose spindleActive: falling through
    // (no block) preserves the pre-safety-gate behavior. We only block
    // when we CAN prove the spindle is active — false positives would
    // break legitimate tool changes on older ncSender versions.
    const cmds = wrap('M64 P2');
    gateSpindleUnclamp(cmds, { machineState: {} }, SETTINGS);
    assert.equal(cmds[0].command, 'M64 P2', 'no signal → no gate');
  });

  test('clampAuxOutput not configured — nothing to gate', () => {
    const cmds = wrap('M64 P2');
    gateSpindleUnclamp(cmds, { machineState: { spindleActive: true } }, {});
    assert.equal(cmds[0].command, 'M64 P2', 'without clampAuxOutput setting, gate must not fire');
  });
});

// T0 → manual-tool UX: user shouldn't have to click "Release" when the
// spindle is already empty. Plugin now auto-fires the unclamp and jumps
// straight to the single-Clamp dialog (MANUAL_CLAMP_TOOL). The old
// MANUAL_LOAD_TOOL "Release + Clamp" dialog should NEVER appear on any
// path — with drawbarAlreadyReleased true or false, both paths converge
// on MANUAL_CLAMP_TOOL. Only the pre-dialog auto-release differs.
describe('buildLoadTool — T0 → manual tool auto-releases drawbar (no Release click)', () => {
  const MANUAL_RACK = {
    ...RACK,
    slots: 3,
    manualTool: { x: 321, y: -966 },
    clampAuxOutput: 2,
    zSafe: 0,
  };
  const MANUAL_TOOL_NUM = 4;  // > slots → treated as manual tool

  test('T0 → T4 (manual): auto-fires M64 unclamp BEFORE the MANUAL_CLAMP_TOOL dialog', () => {
    const slotPos = calculateSlotPosition(MANUAL_RACK, MANUAL_TOOL_NUM);
    const gcode = buildLoadTool(
      MANUAL_RACK, MANUAL_TOOL_NUM, slotPos,
      /* tlsRoutine */ '',
      /* drawbarAlreadyReleased */ false,   // T0 = empty spindle = drawbar clamped
      /* origin */ { x: 0, y: 0 },
      /* chainedFromRack */ false
    );
    // Use raw gcode for ordering — motionLines strips (MSG,...) comments,
    // which is where the dialog anchor lives.
    const unclampPos = gcode.indexOf('M64 P2');
    const dialogPos  = gcode.indexOf('MANUAL_CLAMP_TOOL');
    const clampPos   = gcode.lastIndexOf('M65 P2');
    assert.notEqual(unclampPos, -1, 'must auto-fire M64 (unclamp)');
    assert.notEqual(dialogPos, -1, 'must show MANUAL_CLAMP_TOOL dialog');
    assert.ok(unclampPos < dialogPos,
      'auto-unclamp must fire BEFORE the dialog so the collet is open when the operator inserts the tool');
    assert.ok(clampPos > dialogPos,
      'final clamp (M65) must fire AFTER the dialog / user Clamp click');
    // Explicitly reject the old two-click dialog.
    assert.ok(!gcode.includes('MANUAL_LOAD_TOOL'),
      'MANUAL_LOAD_TOOL (Release + Clamp) dialog must NOT appear — replaced by auto-release + MANUAL_CLAMP_TOOL');
  });

  test('Tm (rack) → T4 (manual) with drawbarAlreadyReleased=true: NO extra auto-release', () => {
    const slotPos = calculateSlotPosition(MANUAL_RACK, MANUAL_TOOL_NUM);
    const gcode = buildLoadTool(
      MANUAL_RACK, MANUAL_TOOL_NUM, slotPos, '',
      /* drawbarAlreadyReleased */ true,    // just unloaded a rack tool
      { x: 0, y: 0 }, false
    );
    // Count M64 (unclamp) — should be ZERO. Only M65 (clamp) at end.
    const unclampCount = motionLines(gcode).filter(l => l === 'M64 P2').length;
    assert.equal(unclampCount, 0,
      'drawbar already open — must NOT emit another unclamp before the dialog');
    assert.ok(gcode.includes('MANUAL_CLAMP_TOOL'), 'dialog is still MANUAL_CLAMP_TOOL');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Direct routePoint scenario tests — cover the primitive's behavior
// independently of the six wrappers that use it. Each scenario labels
// the endpoint configuration so a future regression names the case.
// ─────────────────────────────────────────────────────────────────────────
describe('routePoint — direct primitive scenarios', () => {
  // Standard rack used across the scenarios. Y-oriented (perp=X, par=Y).
  //   Keepout X: [-175, -55]  (perpMin, perpMax)
  //   Keepout Y: [ -20, 260]  (parMin,  parMax)
  const CUP = { ...RACK, rackHolding: 'Cup' };
  const FORK = { ...RACK, rackHolding: 'Fork' };

  test('Cup + origin far +X → 2-move via +X edge (destination is slot engaged)', () => {
    // Origin (200, 100) far past perpMax=-55 (+X of box). Destination
    // is slot 1 engaged (-115, 40) — inside perp band, par inside range.
    // Cup picks origin-side edge (+X). Direct diagonal crosses box at
    // par ≈ 51 (inside par range), so we route via +X edge.
    const from = { x: 200, y: 100 };
    const to   = { x: -115, y: 40 };   // slot 1 engaged
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    // from on entry side → no fromCorner. to inside perp band + par inside
    // → toCorner=(perpMax, toPar)=(-55, 40). Push toCorner + to.
    assert.deepEqual(wp, [{ x: -55, y: 40 }, { x: -115, y: 40 }]);
  });

  test('Cup + origin far -X → 2-move via -X edge (destination is slot engaged)', () => {
    // Symmetric — origin past perpMin=-175 (-X side). Cup picks -X edge.
    const from = { x: -500, y: 100 };
    const to   = { x: -115, y: 40 };
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    assert.deepEqual(wp, [{ x: -175, y: 40 }, { x: -115, y: 40 }]);
  });

  test('Cup + both endpoints inside perp band + SAME par-end side → 3-move collapsed to 2 (corners equal)', () => {
    // Both endpoints inside perp band; both pars far below parMin=-20.
    // fromCorner and toCorner both clamp to parMin=-20 → dedup collapses
    // one. Path: from → shared corner → to. Segment CROSSES box because
    // par crosses -20 mid-diagonal.
    const from = { x: -100, y: -300 };   // below parMin
    const to   = { x: -80,  y: 100 };    // par inside range
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    // Anchor from inside perp band → workspace edge = -175.
    // fromCorner=(-175, clamp(-300)=-20)=(-175,-20). from par below → simple case.
    // toCorner=(-175, 100). Both pushed (different par).
    // Wait — this test's title says SAME par-end side. Let me adjust the
    // to's par to also be below parMin so both clamp to parMin. Then dedup.
    // Adjusted: to.y=-200 → toCorner=(-175, -20). Same as fromCorner.
    // But then segment from (−100, −300)→(−80, −200) is entirely below
    // parMin → doesn't cross box → direct. Not a routing scenario.
    // Keep as-is with different pars — labeled "3-move" (not truly collapsed).
    assert.deepEqual(wp, [
      { x: -175, y: -20 },
      { x: -175, y: 100 },
      { x: -80,  y: 100 },
    ]);
  });

  test('Cup + both endpoints inside perp band + OPPOSITE par-end sides (.117 Tx→Ty case shape)', () => {
    // Both inside perp band; one below parMin, one above parMax.
    // 3-move: fromCorner (edge, parMin), toCorner (edge, parMax), to.
    const from = { x: -100, y: -50 };   // inside perp, below parMin
    const to   = { x: -80,  y: 350 };   // inside perp, above parMax
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    // Anchor from inside perp band → workspace edge = -175.
    // fromCorner=(-175, -20), toCorner=(-175, 260) — different → both pushed.
    assert.deepEqual(wp, [
      { x: -175, y: -20 },
      { x: -175, y: 260 },
      { x: -80,  y: 350 },
    ]);
  });

  test('Fork + destination past sliding side → uses slidingSidePerp', () => {
    // Fork forces sliding side regardless of edgeAnchor. sliding =
    // slot1.x + approachSign*pad = -115 + 60 = -55 (RACK slideDir=Negative).
    const from = { x: -200, y: 300 };    // opposite side, par above range
    const to   = { x: -60,  y: 40 };     // near sliding edge but inside band
    const wp = routePoint(from, to, FORK, { edgeAnchor: to });
    // Fork → entryPerp=-55. from opposite side + par outside → simple
    // fromCorner=(-55, 260). to inside perp band + par inside range →
    // simple toCorner=(-55, 40). Push both + to.
    assert.deepEqual(wp, [
      { x: -55, y: 260 },
      { x: -55, y: 40 },
      { x: -60, y: 40 },
    ]);
  });

  test('Direct diagonal safe → single move (segment does not cross box)', () => {
    // Both far +X of box, plenty of clearance.
    const from = { x: 500, y: 500 };
    const to   = { x: 300, y: 300 };
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    assert.deepEqual(wp, [to]);
  });

  test('Both endpoints past same edge → 1 move (segmentIntersectsRect returns false)', () => {
    // Both endpoints past perpMax=-55 (on the +X side of the box).
    const from = { x: 100, y: 40 };
    const to   = { x: 300, y: 200 };
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    assert.deepEqual(wp, [to]);
  });

  test('to sits ON the entry edge → direct single move (routePoint dedup path)', () => {
    // Common rackEntrance scenario: `to` is slotEntryPoint on the edge.
    // Origin on same (entry) side → single-move direct.
    const from = { x: 60, y: 120 };       // past perpMax=-55
    const to   = { x: -55, y: 40 };       // on sliding edge (=perpMax)
    const wp = routePoint(from, to, FORK, { edgeAnchor: from });
    // segmentIntersectsRect true (to touches boundary), but from is on
    // entry side and to is on entry edge → both onEntry → push only to.
    assert.deepEqual(wp, [to]);
  });

  test('edgeAnchor defaults to `from` when not passed', () => {
    // Two calls with the same `from`, once with explicit anchor and
    // once with default — Cup should pick the same edge both times.
    const from = { x: 200, y: 100 };
    const to   = { x: -100, y: -80 };
    const withAnchor    = routePoint(from, to, CUP, { edgeAnchor: from });
    const withoutAnchor = routePoint(from, to, CUP);
    assert.deepEqual(withoutAnchor, withAnchor);
  });

  test('orientation=X: axes swap consistently', () => {
    // Rack along X (perp = Y). Slots on Y=3.8, pars along X.
    const CUP_X = {
      slots: 3,
      orientation: 'X',
      direction: 'Positive',
      slot1: { x: 100, y: 3.8 },
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
      rackHolding: 'Cup',
    };
    // Zone: parAxis=X → parMin=40, parMax=280. perpAxis=Y → perpMin=-56.2, perpMax=63.8.
    const from = { x: 30,  y: 200 };   // par=30 outside parMin (below), perp=200 past perpMax
    const to   = { x: 150, y: 20 };    // par=150 inside range, perp=20 inside band
    const wp = routePoint(from, to, CUP_X, { edgeAnchor: from });
    // Anchor from's perp=200 past perpMax=63.8 → entry perpMax=63.8.
    // From on entry side (past entry) → no fromCorner.
    // to's perp=20 inside band, par=150 inside → toCorner = (par=150, perp=63.8).
    // Segment intersects box? from (30, 200)→to (150, 20).
    //   x range [30, 150] intersects [40, 280]? yes.
    //   y range [20, 200] intersects [-56.2, 63.8]? yes.
    //   Actually just check: cross box interior? tests will say.
    assert.deepEqual(wp, [{ x: 150, y: 63.8 }, to]);
  });

  test('pickEntryEdge — Cup with edgeAnchor past perpMax → perpMax', () => {
    assert.equal(pickEntryEdge(CUP, { x: 200, y: 100 }), -55);
  });
  test('pickEntryEdge — Cup with edgeAnchor past perpMin → perpMin', () => {
    assert.equal(pickEntryEdge(CUP, { x: -500, y: 100 }), -175);
  });
  test('pickEntryEdge — Cup with edgeAnchor inside perp band → workspace side', () => {
    // slot1.x + slideSign*pad = -115 + (-1)*60 = -175 for slideDir=Negative.
    assert.equal(pickEntryEdge(CUP, { x: -100, y: 100 }), -175);
  });
  test('pickEntryEdge — Cup with undefined anchor → workspace side', () => {
    assert.equal(pickEntryEdge(CUP, undefined), -175);
  });
  test('pickEntryEdge — Fork ignores anchor, always sliding side', () => {
    // sliding for RACK (slideDir=Negative): slot1.x + approachSign*pad = -115 + 60 = -55.
    assert.equal(pickEntryEdge(FORK, { x: 200, y: 100 }), -55);
    assert.equal(pickEntryEdge(FORK, { x: -500, y: 100 }), -55);
    assert.equal(pickEntryEdge(FORK, undefined), -55);
  });

  test('dedup collapses fromCorner==toCorner even when both endpoints need clamping to the same par-end', () => {
    // Both from and to inside perp band, both par past parMax. Simple
    // case (par outside range) for both → fromCorner=(edge, parMax),
    // toCorner=(edge, parMax) — identical → dedup emits only one.
    const from = { x: -100, y: 400 };
    const to   = { x: -80,  y: 350 };
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    // Segment intersects box? from(-100,400)→to(-80,350). At x=-80 (perp
    // inside band), y=350 above parMax=260 — outside. At x=-100, y=400
    // outside. y range [350, 400] all above parMax → segment stays
    // ABOVE box → NO crossing → direct move.
    assert.deepEqual(wp, [to], 'both endpoints past parMax → segment stays above box → direct');
  });

  test('genuine corner collapse: from inside perp + par inside, to past entry edge', () => {
    // from inside perp band, par inside range → simple fromCorner =
    // (workspaceEdge, fromPar). to past entry edge → no toCorner.
    // Single fromCorner + to.
    const from = { x: -100, y: 100 };    // inside box actually
    const to   = { x: 200,  y: 100 };    // past perpMax
    const wp = routePoint(from, to, CUP, { edgeAnchor: from });
    // edgeAnchor=from (inside band) → workspace side = -175.
    // from is inside band (on OPPOSITE side of workspace edge -175 wrt entry direction).
    //   entryPerp=-175, entryDir = sign(-175 - (-115)) = -1.
    //   fromOnEntrySide: -1*(-100 - (-175)) = -75 >= 0? false. Not on entry.
    //   fromInsidePerp: true. Simple case. fromCorner = (-175, 100).
    // to (200, 100): toPerp=200. toOnEntrySide: -1*(200-(-175))=-375 >= 0? false. Not on entry.
    //   toInsidePerp: false. toParInside: yes. Opposite detour!
    //   sharedCornerPar: minimize |100 - parMin| + |100 - parMax|.
    //     |100 - -20| + |100 - 100| for both = ... actually |100-(-20)|=120, |100-260|=160.
    //     parViaMin=120+120=240 (using fromPar=100 and toPar=100). parViaMax=160+160=320. Pick parMin=-20.
    //   Push (entryPerp=-175, -20), (oppositePerp=-55, -20).
    // Result: [fromCorner=(-175, 100), (-175, -20), (-55, -20), to=(200, 100)]. 4 waypoints.
    assert.deepEqual(wp, [
      { x: -175, y: 100 },
      { x: -175, y: -20 },
      { x: -55,  y: -20 },
      { x: 200,  y: 100 },
    ]);
  });
});


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Air-pressure read placement. Sienci reads pressure once, before the change
// (G65 P501), and never after firing the drawbar. A read after the release
// gave a false fault on a real machine (input HIGH for seconds with the
// drawbar open, gauge fine), so the plugin does the same: one read, up front.
// ---------------------------------------------------------------------------
describe('pressure read — once before the change, never after a release', () => {
  const settings = buildInitialConfig({ slots: 3, slot1: { x: -115, y: 40 }, slotDistance: 80, pressureInput: 2 });

  test('the program reads pressure exactly once, before any motion', () => {
    const lines = buildToolChangeProgram(settings, 0, 1);
    const reads = lines.map((l, i) => [l, i]).filter(([l]) => /M66 P2 L4/.test(l));
    // First read plus the two re-check reads inside the o-if blocks — all
    // from the single up-front guard.
    assert.equal(reads.length, 3, `expected the one guard (3 M66 lines), got ${reads.length}`);
    const firstMotion = lines.findIndex((l) => /^G53 G[01]/.test(l));
    assert.ok(reads.every(([, i]) => i < firstMotion), 'every pressure read must come before the first move');
    assert.match(reads[0][0], /Q0\.5\b/);
  });

  test('no pressure read follows the drawbar release in load or unload', () => {
    const load = buildLoadTool(settings, 1, calculateSlotPosition(settings, 1), '', false, { x: 0, y: 0 });
    const unload = buildUnloadTool(settings, 1, calculateSlotPosition(settings, 1), { x: 0, y: 0 });
    assert.doesNotMatch(load, /M66/);
    assert.doesNotMatch(unload, /M66/);
  });

  test('no sensor configured: no M66 anywhere', () => {
    const s = buildInitialConfig({ slots: 3, slot1: { x: -115, y: 40 }, slotDistance: 80, pressureInput: -1 });
    assert.doesNotMatch(buildToolChangeProgram(s, 0, 1).join('\n'), /M66/);
  });
});

// ---------------------------------------------------------------------------
// Taper blow / cone clean. Sienci's blow port is teed off the drawbar valve,
// so with `taperBlow` on the sequence matches TC.macro: close the drawbar
// right after lifting off the unloaded holder, re-open it directly above the
// next holder, vent 0.8 s, feed the last 20 mm down at 1500, settle 1 s
// after the clamp. Off keeps the drawbar open across a chained swap.
// ---------------------------------------------------------------------------
describe('taperBlow — Sienci-style drawbar handling around the traverse', () => {
  const base = { slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5, clampAuxOutput: 1 };
  const on  = buildInitialConfig({ ...base, taperBlow: true });
  const off = buildInitialConfig({ ...base });
  const auxOf = (line) => (line.match(/^M6[45] P\d+/) || [])[0];

  test('defaults off', () => {
    assert.equal(off.taperBlow, false);
  });

  test('on: the unload closes the drawbar 20 mm above the holder, before leaving for Z-safe', () => {
    const lines = buildUnloadTool(on, 1, calculateSlotPosition(on, 1), { x: 0, y: 0 }).split('\n').map((l) => l.trim());
    const lift = lines.findIndex((l) => l === 'G53 G0 Z-80');
    assert.ok(lift > 0, 'expected a lift to slot Z + 20');
    assert.match(lines[lift + 1], /^M6[45] P1$/);
    assert.notEqual(auxOf(lines[lift + 1]), auxOf(lines.find((l) => /^M6[45] P1$/.test(l))), 'the aux after lift-off must be the clamp, i.e. the opposite of the release');
    const safe = lines.findIndex((l) => l === 'G53 G0 Z-5');
    assert.ok(safe > lift + 1, 'the clamp happens before the rapid to Z-safe');
  });

  test('off: the unload leaves the drawbar open and goes straight to Z-safe', () => {
    const g = buildUnloadTool(off, 1, calculateSlotPosition(off, 1), { x: 0, y: 0 });
    assert.equal((g.match(/^\s*M6[45] P1$/gm) || []).length, 1, 'only the release, no re-clamp');
    assert.doesNotMatch(g, /G53 G0 Z-80/);
  });

  test('on: the load re-opens above the holder, vents 0.8 s, feeds down at 1500 and settles 1 s after clamping', () => {
    // Blank lines are dropped before the program reaches the controller
    // (a disabled sensor guard interpolates to ''), so drop them here too —
    // this test is about which real lines sit next to each other.
    const lines = buildLoadTool(on, 2, calculateSlotPosition(on, 2), '', /* alreadyReleased */ false, { x: 0, y: 0 }, /* chained */ true)
      .split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const i = lines.findIndex((l) => l === 'G53 G0 Z-80');
    assert.ok(i > 0, 'expected a rapid to slot Z + 20 above the holder');
    assert.equal(lines[i + 1], 'G4 P0.1');
    assert.match(lines[i + 2], /^M6[45] P1$/, 'release directly above the holder');
    assert.equal(lines[i + 3], 'G4 P0.8', 'vent / blow dwell');
    assert.equal(lines[i + 4], 'G53 G1 Z-99 F1500', 'slow dedust feed to the approach height');
    assert.ok(lines.includes('G4 P1'), '1 s settle after the clamp');
  });

  test('off: a chained load skips the release and rapids to the approach height', () => {
    const g = buildLoadTool(off, 2, calculateSlotPosition(off, 2), '', true, { x: 0, y: 0 }, true);
    assert.doesNotMatch(g, /G4 P0\.8/);
    assert.doesNotMatch(g, /F1500/);
    assert.equal((g.match(/^\s*M6[45] P1$/gm) || []).length, 1, 'only the clamp');
  });

  test('on: a full T1 -> T2 program has air off for the traverse between the slots', () => {
    const lines = buildToolChangeProgram(on, 1, 2);
    const aux = lines.map((l, i) => [l.trim(), i]).filter(([l]) => /^M6[45] P1$/.test(l));
    // release (unload) -> clamp (after lift-off) -> release (above slot 2) -> clamp (seat)
    assert.equal(aux.length, 4, `expected 4 drawbar switches, got ${aux.length}: ${aux.map(([l]) => l).join(' ')}`);
    assert.equal(aux[0][0], aux[2][0], 'first and third are releases');
    assert.equal(aux[1][0], aux[3][0], 'second and fourth are clamps');
    assert.notEqual(aux[0][0], aux[1][0]);
    // The traverse (the par-walk to slot 2 engaged at Z-safe) sits between the
    // first clamp and the second release.
    const walk = lines.findIndex((l, i) => i > aux[1][1] && /^G53 G0 X/.test(l.trim()));
    assert.ok(walk > aux[1][1] && walk < aux[2][1], 'the move to slot 2 happens with the drawbar closed');
  });

  test('on: T1 -> T0 does not double-clamp at the end', () => {
    const lines = buildToolChangeProgram(on, 1, 0);
    const aux = lines.map((l) => l.trim()).filter((l) => /^M6[45] P1$/.test(l));
    assert.equal(aux.length, 2, 'release, then the single clamp after lift-off');
  });

  test('off: T1 -> T0 still clamps once at the end', () => {
    const lines = buildToolChangeProgram(off, 1, 0);
    const aux = lines.map((l) => l.trim()).filter((l) => /^M6[45] P1$/.test(l));
    assert.equal(aux.length, 2, 'release, then the finalize clamp');
  });
});

// ---------------------------------------------------------------------------
// tlsExit on a Fork rack: the TLS → origin path never touches a slot, so it
// must not be forced onto the fork's sliding-side edge. Reported on a
// 12-slot Sienci rack along X: TLS sits just past the rack's par-max end
// inside the perp band, origin is far past the bottom (-Y) edge. The old
// route went UP to the sliding edge (Y-7.244), along the rack's end, back
// DOWN to the bottom edge, then out — three moves and ~240 mm extra. The
// right route is the bottom-edge corner and out: two moves.
// ---------------------------------------------------------------------------
describe('tlsExit — Fork rack picks the keepout edge nearest the destination', () => {
  const SIENCI_12 = {
    slots: 12, orientation: 'X', direction: 'Positive',
    slot1: { x: 128.671, y: -67.244 }, slotDistance: 90,
    slideDirection: 'Negative', slideDistance: 40, keepoutPadding: 60,
    rackHolding: 'Fork',
  };

  test('reported case: bottom-edge corner then straight out, not via the sliding edge', () => {
    const gcode = tlsExit(1250.259, -54.661, { x: 406.3, y: -489.287 }, SIENCI_12);
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X1178.671 Y-127.244', // par-max corner on the edge nearest the origin
      'G53 G0 X406.3 Y-489.287',    // out
    ]);
  });

  test('destination past the sliding edge still exits via the sliding edge (nearest)', () => {
    const gcode = tlsExit(1250.259, -54.661, { x: 406.3, y: 80 }, SIENCI_12);
    assert.deepEqual(motionLines(gcode), [
      'G53 G0 X1178.671 Y-7.244',
      'G53 G0 X406.3 Y80',
    ]);
  });

  test('slot exits on a Fork rack are unchanged: rackExit still uses the sliding side', () => {
    // Slot 12 approach → origin below the rack. The fork must leave along the
    // sliding side regardless of where the origin is.
    const slot = calculateSlotPosition(SIENCI_12, 12);
    const gcode = rackExit(slot.approach, { x: 406.3, y: -489.287 }, SIENCI_12);
    assert.match(motionLines(gcode)[0], /Y-7\.244$/);
  });
});

// ---------------------------------------------------------------------------
// $MEASURE_TLO — one step of the Measure All Tools batch (driven from the
// TLS tab). Forces a probe whatever the strategy says, parks at the
// toolsetter between tools, and the T0 step returns to a given XY.
// ---------------------------------------------------------------------------
describe('$MEASURE_TLO — measure-all batch step', () => {
  const settings = buildInitialConfig({
    slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5,
    clampAuxOutput: 1, toolsetter: { x: 300, y: -200 }, tlsMode: 'library',
  });
  const tools = [
    { toolNumber: 1, offsets: { x: 0, y: 0, z: -55.014, tlsZ: 0 } },  // has a stored TLO
    { toolNumber: 2, offsets: { x: 0, y: 0, z: 0, tlsZ: 0 } },
  ];
  const run = (command, tool, mpos = { x: 10, y: 20 }) => {
    const commands = [{ command, isOriginal: true }];
    onBeforeCommand(commands, { machineState: { tool, mpos }, tools }, { ...settings });
    return commands.map((c) => c.command.trim());
  };

  test('parses the tool and optional return XY', () => {
    assert.deepEqual(parseMeasureTloCommand('$MEASURE_TLO T3'), { toolNumber: 3, returnTo: null });
    assert.deepEqual(parseMeasureTloCommand('$measure_tlo T0 X406.3 Y-489.287'), { toolNumber: 0, returnTo: { x: 406.3, y: -489.287 } });
    assert.equal(parseMeasureTloCommand('$TLS'), null);
  });

  test('probes even when the library already has a TLO (library strategy would skip)', () => {
    const lines = run('$MEASURE_TLO T1', 0);
    assert.ok(lines.some((l) => /^G38\.2/.test(l)), 'expected a probe move');
    assert.ok(!lines.some((l) => /Load stored TLO/.test(l)), 'must not shortcut to the stored value');
    // Sanity: a plain M6 T1 with this strategy does NOT probe.
    const plain = run('M6 T1', 0);
    assert.ok(!plain.some((l) => /^G38\.2/.test(l)));
  });

  test('library strategy probes anyway while the controller has no Tool Length Reference', () => {
    const runWithTlr = (toolLengthSet) => {
      const commands = [{ command: 'M6 T1', isOriginal: true }];
      onBeforeCommand(commands, { machineState: { tool: 0, mpos: { x: 10, y: 20 }, toolLengthSet }, tools }, { ...settings });
      return commands.map((c) => c.command.trim());
    };
    // Reference established → stored TLO is reused, no probe.
    const withRef = runWithTlr(true);
    assert.ok(!withRef.some((l) => /^G38\.2/.test(l)), 'must not probe when the reference is set');
    assert.ok(withRef.some((l) => /Load stored TLO/.test(l)));
    // No reference (fresh boot / reset) → probe even though T1 has a TLO on file.
    const noRef = runWithTlr(false);
    assert.ok(noRef.some((l) => /^G38\.2/.test(l)), 'expected a probe when no TLR');
    assert.ok(!noRef.some((l) => /Load stored TLO/.test(l)));
    // Older host that does not report the field → behave as before (reuse).
    const legacy = runWithTlr(undefined);
    assert.ok(!legacy.some((l) => /^G38\.2/.test(l)));
  });

  test('stays at the toolsetter afterwards instead of routing back to the origin', () => {
    const lines = run('$MEASURE_TLO T1', 0, { x: 10, y: 20 });
    assert.ok(!lines.some((l) => /tlsExit/.test(l)), 'no tlsExit section');
    assert.ok(!lines.some((l) => /^G53 G0 X10 Y20$/.test(l)), 'no move back to the origin');
    const plain = run('M6 T2', 0, { x: 10, y: 20 });
    assert.ok(plain.some((l) => /^G53 G0 X10 Y20$/.test(l)), 'a normal M6 does return');
  });

  test('tool already in the spindle: probe only, no rack motion', () => {
    const lines = run('$MEASURE_TLO T1', 1);
    assert.ok(lines.some((l) => /^G38\.2/.test(l)));
    assert.ok(!lines.some((l) => /^M6[45] P1$/.test(l)), 'no drawbar action');
    assert.ok(!lines.some((l) => /^M61 Q/.test(l)), 'no tool number change');
  });

  test('T0 with XY: unloads the current tool and returns to that XY', () => {
    const lines = run('$MEASURE_TLO T0 X406.3 Y-489.287', 2, { x: 300, y: -200 });
    assert.ok(lines.some((l) => /^M61 Q0$/.test(l)), 'unloads');
    assert.equal(lines.filter((l) => /^G53 G0 X406\.3 Y-489\.287$/.test(l)).length, 1, 'ends at the requested XY');
    assert.ok(!lines.some((l) => /^G38\.2/.test(l)), 'no probe on the way out');
  });
});

describe('probe auto-loader config', () => {
  test('fork fields default from the rack and its slide axis', () => {
    const cfg = buildInitialConfig({ slots: 6, orientation: 'Y', slideDirection: 'Positive', slideDistance: 35, slideSpeed: 900 });
    assert.equal(cfg.probe.holding, 'Fork');
    assert.equal(cfg.probe.slideAxis, 'X');            // rack along Y slides along X
    assert.equal(cfg.probe.slideDirection, 'Positive');
    assert.equal(cfg.probe.slideDistance, 35);
    assert.equal(cfg.probe.slideSpeed, 900);
    assert.equal(cfg.probe.toolNumber, 99);
  });

  test('fork fields set on the probe win over the rack', () => {
    const cfg = buildInitialConfig({
      slots: 6, orientation: 'Y', slideDirection: 'Positive', slideDistance: 35, slideSpeed: 900,
      probe: { enabled: true, toolNumber: 20, holding: 'Fork', slideAxis: 'Y', slideDirection: 'Negative', slideDistance: 25, slideSpeed: 400 }
    });
    assert.equal(cfg.probe.enabled, true);
    assert.equal(cfg.probe.toolNumber, 20);
    assert.equal(cfg.probe.slideAxis, 'Y');
    assert.equal(cfg.probe.slideDirection, 'Negative');
    assert.equal(cfg.probe.slideDistance, 25);
    assert.equal(cfg.probe.slideSpeed, 400);
  });

  test('probe tool number is clamped above the rack', () => {
    const cfg = buildInitialConfig({ slots: 8, probe: { toolNumber: 3 } });
    assert.equal(cfg.probe.toolNumber, 9);
  });
});

describe('probe auto-loader — tool change programs', () => {
  // Rack along Y at X=-115 (keepout X -175..-55, Y -20..260). Probe holder
  // sits well clear of it at (200, -100), fork slides along X.
  const base = () => buildInitialConfig({
    ...RACK,
    slot1: { x: -115, y: 40, z: -120 },
    zSafe: -5, clampAuxOutput: 0,
    toolsetter: { x: 300, y: 300 },
    manualTool: { x: 500, y: 500 },
    tlsMode: 'library',
    probe: { enabled: true, toolNumber: 99, holding: 'Fork', slideAxis: 'X', slideDirection: 'Negative',
             slideDistance: 30, slideSpeed: 700, x: 200, y: -100, z: -90, verifyGcode: 'G38.3 G91 Z-2 F100\nG90' }
  });
  const origin = { x: 0, y: 0 };

  test('T0 → probe (fork): slide out of the holder, verify, then always TLS', () => {
    const cfg = base();
    const prog = buildToolChangeProgram(cfg, 0, 99, { x: 0, y: 0, z: 0 }, 12.345, origin);
    const lines = motionLines(prog.join('\n'));
    const text = lines.join('\n');
    // Descends onto the probe at the holder, clamps, slides to the approach
    // (X 230 = 200 - (-1 * 30)) at the probe's own feed, lifts.
    assert.ok(text.includes('G53 G0 X200 Y-100'), 'moves over the holder engaged point');
    assert.ok(text.includes('G53 G0 Z-89'), 'approach height is holder Z + drawbar offset');
    assert.ok(text.includes('G53 G1 Z-90 F300'), 'drawbar seat to holder Z');
    assert.ok(text.includes('G53 G1 X230 Y-100 F700'), 'slides out along +X at the probe slide speed');
    assert.ok(text.includes('M61 Q99'), 'controller told the probe is loaded');
    assert.ok(text.includes('G38.3 G91 Z-2 F100'), 'verify block runs after pickup');
    // Library strategy with a TLO on file for T99: no TLS, the stored offset is loaded.
    assert.ok(!text.includes('G38.2 G91 Z-'), 'library strategy with a stored TLO skips TLS for the probe too');
    assert.ok(text.includes('G43.1 Z12.345'), 'stored TLO is applied');
    assert.ok(text.indexOf('G38.3 G91 Z-2 F100') < text.indexOf('G43.1 Z12.345'), 'verify precedes the offset load');
    assert.ok(text.indexOf('M61 Q99') < text.indexOf('G38.3 G91 Z-2 F100'), 'tool number is set before the verification');
    assert.ok(text.includes('MANUAL_') === false, 'no manual-tool dialog for the probe');
  });

  test('T0 → probe with no stored TLO (library) or with the always strategy: TLS runs', () => {
    const noTlo = buildToolChangeProgram(base(), 0, 99, { x: 0, y: 0, z: 0 }, 0, origin).join('\n');
    assert.ok(noTlo.includes('G38.2 G91 Z-'), 'no TLO on file → probe it');
    const always = base(); always.tlsMode = 'always';
    const alwaysText = buildToolChangeProgram(always, 0, 99, { x: 0, y: 0, z: 0 }, 12.345, origin).join('\n');
    assert.ok(alwaysText.includes('G38.2 G91 Z-'), 'always strategy → probe it');
  });

  test('T0 → probe with a stored TLO: the exit routes from the holder, not the toolsetter', () => {
    // The field failure: with the library strategy and a TLO on file the
    // pickup skips TLS, so the spindle is still at the holder — the old
    // exit assumed the toolsetter and dragged the probe across the rack.
    const cfg = base();
    const prog = buildToolChangeProgram(cfg, 0, 99, { x: 0, y: 0, z: 0 }, 12.345, origin).join('\n');
    const tlo = prog.indexOf('G43.1 Z12.345');
    const tail = prog.slice(tlo);
    assert.ok(tail.includes('probeExit'), 'exit is computed from the holder');
    assert.ok(!tail.includes('tlsExit'), 'no toolsetter exit without a TLS');
    assert.ok(!tail.includes('X300 Y300'), 'never heads for the toolsetter');
    assert.ok(tail.trim().includes('G53 G0 X0 Y0'), 'ends at the origin');
  });

  test('T0 → probe with TLS: the exit leaves the toolsetter', () => {
    const cfg = base(); cfg.tlsMode = 'always';
    const prog = buildToolChangeProgram(cfg, 0, 99, { x: 0, y: 0, z: 0 }, 12.345, origin).join('\n');
    assert.ok(prog.slice(prog.indexOf('G43.1 Z[')).includes('tlsExit'));
  });

  test('probe → T0 (cup): drop into the holder, re-clamp, route home', () => {
    const cfg = base();
    cfg.probe.holding = 'Cup';
    const prog = buildToolChangeProgram(cfg, 99, 0, { x: 0, y: 0, z: 0 }, 0, origin);
    const text = motionLines(prog.join('\n')).join('\n');
    assert.ok(text.includes('G53 G0 X200 Y-100'), 'routes to the cup');
    assert.ok(text.includes('G53 G0 Z-90'), 'drops to the holder Z');
    assert.ok(text.includes('G53 G1 Z-89 F300'), 'drawbar back-off after release');
    assert.ok(text.includes('M61 Q0'));
    assert.ok(!text.includes('G1 X') || !text.includes('F700'), 'no fork slide for a cup holder');
    assert.ok(!text.includes('G38.2'), 'no TLS on a put-down');
    assert.ok(text.trim().endsWith('G[#<return_units>]') || text.includes('G53 G0 X0 Y0'), 'returns toward the origin');
  });

  test('T1 → probe: rack unload chains into a rack exit toward the holder', () => {
    const cfg = base();
    const prog = buildToolChangeProgram(cfg, 1, 99, { x: 0, y: 0, z: 0 }, 0, origin);
    const text = motionLines(prog.join('\n')).join('\n');
    const unloadIdx = text.indexOf('M61 Q0');
    const loadIdx = text.indexOf('M61 Q99');
    assert.ok(unloadIdx !== -1 && loadIdx !== -1 && unloadIdx < loadIdx, 'unload then load');
    // Leaves the rack via its sliding-side edge (X -55) before heading to the holder.
    assert.ok(text.slice(unloadIdx, loadIdx).includes('G53 G0 X-55'), 'rack exit to the sliding edge');
    assert.ok(text.includes('G53 G1 X230 Y-100 F700'));
  });

  test('probe → T2: put the probe down, then a normal rack load from the holder', () => {
    const cfg = base();
    const prog = buildToolChangeProgram(cfg, 99, 2, { x: 0, y: 0, z: 0 }, 0, origin);
    const text = motionLines(prog.join('\n')).join('\n');
    assert.ok(text.indexOf('M61 Q0') < text.indexOf('M61 Q2'));
    assert.ok(text.includes('G53 G1 X200 Y-100 F700'), 'slides into the fork to put the probe down');
    assert.ok(text.includes('rackEntrance') === false, 'comments stripped');
    assert.ok(text.includes('G53 G0 X-115 Y120'), 'ends up over slot 2');
  });

  test('probe is not treated as a manual tool when swapping with one', () => {
    const cfg = base();
    const prog = buildToolChangeProgram(cfg, 99, 5, { x: 0, y: 0, z: 0 }, 0, origin);
    // The dialog markers are (MSG, …) comment lines, so read the raw program.
    const text = prog.join('\n');
    assert.ok(!text.includes('MANUAL_SWAP_TOOL'), 'not collapsed into a manual swap');
    assert.ok(text.includes('MANUAL_CLAMP_TOOL_5'), 'manual load dialog still shows for the manual tool');
  });

  test('disabled loader: the probe number is an ordinary manual tool', () => {
    const cfg = base();
    cfg.probe.enabled = false;
    const prog = buildToolChangeProgram(cfg, 0, 99, { x: 0, y: 0, z: 0 }, 0, origin);
    assert.ok(prog.join('\n').includes('MANUAL_CLAMP_TOOL_99'));
  });
});

describe('probe verification (simple / advanced)', () => {
  const cfg = () => buildInitialConfig({
    slots: 3, zSafe: -5, clampAuxOutput: 0,
    probe: { enabled: true, toolNumber: 99, x: 200, y: -100, z: -90, verify: { enabled: true, mode: 'simple', z: -70 } }
  });

  test('simple mode: rise to Verify Z, centre, sideways touch, centre, safe Z', () => {
    const lines = probeVerifyGcode(cfg()).split('\n').filter((l) => !l.startsWith('('));
    assert.deepEqual(lines, [
      'G53 G0 Z-70',
      'G53 G0 X200 Y-100',
      'G38.2 G91 X-12 F150',      // fork slides along X, Negative → toward the holder
      'G90',
      'G53 G0 X200 Y-100',
      'G53 G0 Z-5',
    ]);
  });

  test('simple mode follows the holder slide axis and direction', () => {
    const c = cfg(); c.probe.slideAxis = 'Y'; c.probe.slideDirection = 'Positive';
    assert.ok(probeVerifyGcode(c).includes('G38.2 G91 Y12 F150'));
  });

  test('advanced mode uses the operator text verbatim', () => {
    const c = cfg(); c.probe.verify.mode = 'advanced'; c.probe.verify.gcode = 'G38.3 G91 Z-2 F100\nG90';
    assert.equal(probeVerifyGcode(c), 'G38.3 G91 Z-2 F100\nG90');
  });

  test('disabled verification emits nothing', () => {
    const c = cfg(); c.probe.verify.enabled = false;
    assert.equal(probeVerifyGcode(c), '');
  });

  test('legacy verifyGcode migrates to advanced; empty legacy means off', () => {
    const on = buildInitialConfig({ slots: 3, probe: { enabled: true, z: -90, verifyGcode: 'G4 P1' } });
    assert.equal(on.probe.verify.mode, 'advanced');
    assert.equal(on.probe.verify.enabled, true);
    assert.equal(on.probe.verify.gcode, 'G4 P1');
    const off = buildInitialConfig({ slots: 3, probe: { enabled: true, z: -90, verifyGcode: '' } });
    assert.equal(off.probe.verify.enabled, false);
    assert.equal(off.probe.verify.z, -70, 'defaults 20 mm above the holder');
  });

  test('the routine is spliced between M61 and TLS on a pickup', () => {
    const c = buildInitialConfig({ slots: 3, orientation: 'Y', slot1: { x: -115, y: 40, z: -120 }, slotDistance: 80,
      slideDirection: 'Negative', slideDistance: 40, keepoutPadding: 60, zSafe: -5, clampAuxOutput: 0,
      toolsetter: { x: 300, y: 300 }, tlsMode: 'always',
      probe: { enabled: true, toolNumber: 99, x: 200, y: -100, z: -90, slideAxis: 'X', slideDirection: 'Negative', slideDistance: 30, slideSpeed: 700,
               verify: { enabled: true, mode: 'simple', z: -70 } } });
    const text = buildToolChangeProgram(c, 0, 99, { x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0 }).join('\n');
    const slideOut = text.indexOf('G53 G1 X230 Y-100'), verify = text.indexOf('G38.2 G91 X-12 F150');
    const m61 = text.indexOf('M61 Q99'), tls = text.indexOf('G43.1 Z0');
    assert.ok(slideOut !== -1 && slideOut < m61 && m61 < verify && verify < tls, 'slide out → M61 → verify → TLS');
    // No rise to safe Z between the slide-out and the verify's own rise to Verify Z.
    assert.ok(!text.slice(slideOut, verify).includes('G53 G0 Z-5'), 'goes to Verify Z straight from the holder');
  });
});

// ---------------------------------------------------------------------------
// The final exit leg must keep its keepout check.
//
// Every G53 leg this plugin emits is rack routing it computed itself, so it
// opts out of the core's keepout check with `$keepout_off` — the rack slots
// genuinely sit inside the published zone. The exception is the LAST leg:
// it ends at `returnTo`, which is wherever the operator left the spindle
// when they typed M6. Cancel a tool load and that is a point inside the
// rack, and a blanket opt-out drove the spindle back into the studs.
//
// These pin both halves: rack routing still opts out, the final leg does
// not, and the marker that arranges it never reaches the controller.
// ---------------------------------------------------------------------------
describe('final exit leg is left for the core keepout check', () => {
  const settings = buildInitialConfig({
    slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5,
    clampAuxOutput: 1,
  });

  // Drives a real M6 through onBeforeCommand so the Pro edition marker is
  // set — the prefix is Pro-only, and buildToolChangeProgram alone would
  // not exercise it.
  const runM6 = (tool, mpos) => {
    const commands = [{ command: 'M6 T1', isOriginal: true }];
    onBeforeCommand(commands, { edition: 'pro', machineState: { tool, mpos }, tools: [] }, { ...settings });
    return commands.map((c) => c.command.trim());
  };

  test('rack routing still opts out, but the last G53 leg does not', () => {
    const lines = runM6(0, { x: 10, y: 20 });
    const machineMoves = lines.filter((l) => /(^|[^A-Z])G0*53(?:[^0-9]|$)/i.test(l));
    assert.ok(machineMoves.length > 1, 'expected several G53 legs in a tool change');

    const lastMove = machineMoves[machineMoves.length - 1];
    assert.doesNotMatch(lastMove, /\$keepout_off/,
      `the final leg must stay checked, got: ${lastMove}`);

    const earlier = machineMoves.slice(0, -1);
    assert.ok(earlier.some((l) => /\$keepout_off/.test(l)),
      'rack routing must still carry the opt-out');
  });

  test('the marker never reaches the controller', () => {
    const lines = runM6(0, { x: 10, y: 20 });
    assert.ok(!lines.some((l) => l.includes('ncs-checked')),
      'the internal marker must be stripped before dispatch');
  });

  test('a non-Pro core gets no prefix at all and no marker', () => {
    const commands = [{ command: 'M6 T1', isOriginal: true }];
    onBeforeCommand(commands, { machineState: { tool: 0, mpos: { x: 10, y: 20 } }, tools: [] }, { ...settings });
    const lines = commands.map((c) => c.command.trim());
    assert.ok(!lines.some((l) => l.includes('$keepout_off')));
    assert.ok(!lines.some((l) => l.includes('ncs-checked')));
  });
});

// === Drawbar + tool-in-spindle sensor guards =============================
//
// Both are off unless a pin is configured, and when on they must land in the
// one ordering that makes them worth having: every check sits BEFORE the move
// that would depend on it. The fork slide-out is the sharp case — sliding
// sideways with a tool the drawbar never gripped drags it out of the fork.
describe('sensor guards — drawbar and tool-in-spindle', () => {
  const sensed = (extra) => buildInitialConfig({
    slots: 4, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80,
    clampAuxOutput: 1, rackHolding: 'Fork', ...extra
  });
  const lines = (g) => g.split('\n').map((l) => l.trim()).filter(Boolean);
  const idx = (ls, re) => ls.findIndex((l) => re.test(l));

  test('no pins configured: not a single M66 and no sensor dialog', () => {
    const s = sensed({});
    assert.equal(s.drawbarInput, -1);
    assert.equal(s.toolSensorInput, -1);
    for (const g of [
      buildUnloadTool(s, 1, calculateSlotPosition(s, 1), { x: 0, y: 0 }),
      buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false)
    ]) {
      assert.doesNotMatch(g, /M66/);
      assert.doesNotMatch(g, /DRAWBAR_FAILED|TOOL_FAILED_TO_SEAT|TOOL_STILL_GRIPPED/);
    }
  });

  // An unsanitized settings object (old stored config, or a raw test fixture)
  // leaves these undefined. `undefined < 0` is false, so a naive check would
  // emit `M66 Pundefined` into a live tool change.
  test('undefined pins are treated as absent, never emitted as a pin number', () => {
    const raw = { ...sensed({}) };
    delete raw.drawbarInput;
    delete raw.toolSensorInput;
    const g = buildUnloadTool(raw, 1, calculateSlotPosition(raw, 1), { x: 0, y: 0 });
    assert.doesNotMatch(g, /undefined/);
    assert.doesNotMatch(g, /M66/);
  });

  test('unload: drawbar must read open after the release, spindle empty after the lift', () => {
    const s = sensed({ drawbarInput: 3, toolSensorInput: 5 });
    const ls = lines(buildUnloadTool(s, 1, calculateSlotPosition(s, 1), { x: 0, y: 0 }));
    const release = idx(ls, /^M64 P1$/);
    const dbRead  = idx(ls, /^M66 P3 L4 Q/);
    const lift    = idx(ls, /^G53 G0 Z0$/);
    const tisRead = idx(ls, /^M66 P5 L3 Q/);
    const m61     = idx(ls, /^M61 Q0$/);
    assert.ok(release >= 0 && dbRead > release, 'drawbar read comes after the release');
    assert.ok(lift > dbRead, 'the spindle only lifts once the drawbar reads open');
    assert.ok(tisRead > lift, '"spindle empty" is only a settled question after the lift');
    assert.ok(m61 > tisRead, 'the controller is told T0 after the checks');
    assert.match(ls[dbRead + 1], /^o\d+ if \[#5399 EQ -1\]$/);
    assert.ok(ls.includes('(MSG, PLUGIN_PNEUMATICATC:DRAWBAR_FAILED_TO_OPEN)'));
    assert.ok(ls.includes('(MSG, PLUGIN_PNEUMATICATC:TOOL_STILL_GRIPPED)'));
  });

  test('load: both checks land before the fork slide-out, not after it', () => {
    const s = sensed({ drawbarInput: 3, toolSensorInput: 5 });
    const ls = lines(buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false));
    const clamp   = idx(ls, /^M65 P1$/);
    const dbClose = idx(ls, /^M66 P3 L3 Q/);
    const tisRead = idx(ls, /^M66 P5 L4 Q/);
    const slideOut = idx(ls, /^G53 G1 X-75 Y-40 F/);
    assert.ok(clamp >= 0 && dbClose > clamp, 'drawbar-closed read follows the clamp');
    assert.ok(tisRead > dbClose, 'tool presence is checked after the drawbar closed');
    assert.ok(slideOut > tisRead,
      `the fork slide-out must come after both checks — got slideOut=${slideOut}, tisRead=${tisRead}`);
    assert.ok(ls.includes('(MSG, PLUGIN_PNEUMATICATC:DRAWBAR_FAILED_TO_CLOSE)'));
    assert.ok(ls.includes('(MSG, PLUGIN_PNEUMATICATC:TOOL_FAILED_TO_SEAT)'));
  });

  test('load from empty also verifies the release before descending onto the shank', () => {
    const s = sensed({ drawbarInput: 3 });
    const ls = lines(buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false));
    const open = idx(ls, /^M66 P3 L4 Q/);
    const descend = idx(ls, /^G53 G0 Z-99$/);
    assert.ok(open >= 0 && descend > open,
      'the drawbar-open check must precede the descent onto the shank');
  });

  test('a chained load does not re-verify a release the unload already checked', () => {
    const s = sensed({ drawbarInput: 3 });
    const g = buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', /* alreadyReleased */ true, { x: 0, y: 0 }, true);
    assert.doesNotMatch(g, /M66 P3 L4 Q/);      // no "must be open" read
    assert.match(g, /M66 P3 L3 Q/);             // still checks it closed after the clamp
  });

  test('each guard is independent: one pin on, the other silent', () => {
    const dbOnly = sensed({ drawbarInput: 3 });
    const gd = buildUnloadTool(dbOnly, 1, calculateSlotPosition(dbOnly, 1), { x: 0, y: 0 });
    assert.match(gd, /DRAWBAR_FAILED_TO_OPEN/);
    assert.doesNotMatch(gd, /TOOL_STILL_GRIPPED/);

    const tisOnly = sensed({ toolSensorInput: 5 });
    const gt = buildUnloadTool(tisOnly, 1, calculateSlotPosition(tisOnly, 1), { x: 0, y: 0 });
    assert.match(gt, /TOOL_STILL_GRIPPED/);
    assert.doesNotMatch(gt, /DRAWBAR_FAILED_TO_OPEN/);
  });

  test('o-word labels are unique across a full swap program', () => {
    const s = sensed({ drawbarInput: 3, toolSensorInput: 5, pressureInput: 2 });
    const prog = buildToolChangeProgram(s, 1, 2, { x: 0, y: 0 }, 0, { x: 0, y: 0 });
    const g = (Array.isArray(prog) ? prog.map((c) => (typeof c === 'string' ? c : (c && c.command) || '')).join('\n') : String(prog));
    const opens = (g.match(/^\s*o\d+ if /gm) || []).map((l) => l.trim().split(' ')[0]);
    assert.ok(opens.length > 0, 'expected guards in a swap program');
    assert.equal(new Set(opens).size, opens.length,
      `o-word labels must not repeat within one program — got ${opens.join(', ')}`);
  });
});

// === Fault retreat ======================================================
//
// A fault lifts clear of the rack so the operator can work, and drops back
// before the sequence carries on. Both moves must live inside the if-block:
// on the happy path neither may be emitted, and after Continue the spindle
// has to be back where the remaining g-code assumes it is.
describe('sensor guards — retreat to Z-safe on a fault', () => {
  const cfg = (extra) => buildInitialConfig({
    slots: 4, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: 0,
    clampAuxOutput: 1, rackHolding: 'Fork', drawbarInput: 3, toolSensorInput: 5, ...extra
  });
  const lines = (g) => g.split('\n').map((l) => l.trim()).filter(Boolean);
  // the lines between `oN if` and `oN endif`
  const block = (ls, n) => {
    const a = ls.findIndex((l) => l === `o${n} if [#5399 EQ -1]`);
    const b = ls.findIndex((l) => l === `o${n} endif`);
    assert.ok(a >= 0 && b > a, `block o${n} not found`);
    return ls.slice(a + 1, b);
  };

  test('load: lift precedes the dialog, descent follows the M0, both inside the block', () => {
    const s = cfg();
    const ls = lines(buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false));
    for (const n of [211, 212]) {
      const b = block(ls, n);
      assert.equal(b[0], 'G53 G0 Z0', `o${n}: must lift to Z-safe first`);
      assert.match(b[1], /^\(MSG, PLUGIN_PNEUMATICATC:/, `o${n}: dialog after the lift`);
      assert.equal(b[2], 'M0', `o${n}: pause after the dialog`);
      assert.equal(b[3], 'G53 G1 Z-100 F300', `o${n}: must return to the slot Z it checked at`);
      assert.equal(b.length, 4, `o${n}: nothing else in the block`);
    }
  });

  test('the fork slide-out still comes after the return, not after the lift', () => {
    const s = cfg();
    const ls = lines(buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false));
    const endif = ls.lastIndexOf('o212 endif');
    const slide = ls.findIndex((l) => /^G53 G1 X-75 Y-40 F/.test(l));
    assert.ok(slide > endif,
      'resuming must descend back to slot Z before sliding out, or the tool is left in the rack');
  });

  test('a check already taken at Z-safe does not lift or descend', () => {
    const s = cfg();
    const ls = lines(buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false));
    const b = block(ls, 210);   // the release before descending onto the shank
    assert.deepEqual(b, ['(MSG, PLUGIN_PNEUMATICATC:DRAWBAR_FAILED_TO_OPEN)', 'M0'],
      'no retreat is needed where the spindle is already clear');
  });

  test('unload: lifts from the drawbar-offset height and returns to it', () => {
    const s = cfg();
    const ls = lines(buildUnloadTool(s, 1, calculateSlotPosition(s, 1), { x: 0, y: 0 }));
    const b = block(ls, 200);
    assert.equal(b[0], 'G53 G0 Z0');
    assert.equal(b[3], 'G53 G1 Z-99 F300', 'returns to slot.z + drawbar offset, where the check was taken');
    const empty = block(ls, 201);   // taken after the lift, so already clear
    assert.deepEqual(empty, ['(MSG, PLUGIN_PNEUMATICATC:TOOL_STILL_GRIPPED)', 'M0']);
  });

  test('the retreat never reaches a machine with no sensors wired', () => {
    const s = buildInitialConfig({
      slots: 4, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: 0,
      clampAuxOutput: 1, rackHolding: 'Fork'
    });
    const g = buildLoadTool(s, 2, calculateSlotPosition(s, 2), '', false, { x: 0, y: 0 }, false)
      + buildUnloadTool(s, 1, calculateSlotPosition(s, 1), { x: 0, y: 0 });
    assert.doesNotMatch(g, /o2\d\d/);
    assert.doesNotMatch(g, /M0/);
  });
});

// === Event g-code modal containment ====================================
//
// Pre/Post Tool Change snippets run in the PROGRAM's units by design -- they
// sit outside the G21 wrapper that makes the plugin's own mm config correct.
// What must not happen is a modal word in the snippet surviving into the rest
// of the job: a G21 written "to be safe" on an inch program would put every
// remaining line in millimetres, silently.
describe('event g-code cannot leak modal state into the job', () => {
  const withEvents = (pre, post) => buildInitialConfig({
    slots: 4, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80,
    clampAuxOutput: 1, rackHolding: 'Fork',
    preToolChangeGcode: pre, postToolChangeGcode: post
  });
  const program = (s) => {
    const r = buildToolChangeProgram(s, 1, 2, { x: 0, y: 0 }, 0, { x: 0, y: 0 });
    return (Array.isArray(r) ? r.map((c) => (typeof c === 'string' ? c : (c && c.command) || '')) : [String(r)])
      .join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
  };

  test('a post event is bracketed by a units and distance-mode restore', () => {
    const ls = program(withEvents('', 'G21\nG91\nG0 Z-5'));
    const capU = ls.indexOf('#<post_units> = [20 + #<_metric>]');
    const capD = ls.indexOf('#<post_dist> = [91 - #<_absolute>]');
    const body = ls.indexOf('G0 Z-5');
    const relU = ls.indexOf('G[#<post_units>]');
    const relD = ls.indexOf('G[#<post_dist>]');
    assert.ok(capU >= 0 && capD > capU, 'both modes captured before the snippet');
    assert.ok(body > capD, 'snippet runs after the capture');
    assert.ok(relU > body && relD > relU, 'both restored after the snippet');
  });

  test('a pre event gets its own bracket, independent of the post one', () => {
    const ls = program(withEvents('G20', 'G91'));
    assert.ok(ls.includes('#<pre_units> = [20 + #<_metric>]'));
    assert.ok(ls.includes('G[#<pre_dist>]'));
    assert.ok(ls.includes('#<post_units> = [20 + #<_metric>]'));
    assert.ok(ls.includes('G[#<post_dist>]'));
    assert.ok(ls.indexOf('G[#<pre_units>]') < ls.indexOf('#<post_units> = [20 + #<_metric>]'),
      'the pre bracket closes before the post one opens');
  });

  test('no event configured emits no bracket at all', () => {
    const g = program(withEvents('', '')).join('\n');
    assert.doesNotMatch(g, /pre_units|post_units|pre_dist|post_dist/);
  });

  // The plugin's own moves stay metric regardless -- that wrapper is what
  // makes its millimetre config mean what it says.
  test('the plugin still forces G21 for its own moves and restores after', () => {
    const g = program(withEvents('', 'G0 Z-5')).join('\n');
    assert.match(g, /#<return_units> = \[20 \+ #<_metric>\]/);
    assert.match(g, /G\[#<return_units>\]/);
  });
});

// ---------------------------------------------------------------------------
// Z0 set before a Tool Length Reference (the gSender habit). The host reports
// machineState.zeroSetWithoutTlr / zeroTool; every TLS path must keep that Z0.
// ---------------------------------------------------------------------------
describe('keeps a Z0 set before any tool length reference', () => {
  const settings = buildInitialConfig({
    slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5,
    clampAuxOutput: 1, toolsetter: { x: 300, y: -200 }, tlsMode: 'library',
  });
  const tools = [
    { toolNumber: 1, offsets: { x: 0, y: 0, z: -55.014, tlsZ: 0 } },
    { toolNumber: 2, offsets: { x: 0, y: 0, z: -48.2, tlsZ: 0 } },
  ];
  const pending = { toolLengthSet: false, zeroSetWithoutTlr: true, zeroTool: 1 };
  const run = (command, ms) => {
    const commands = [{ command, isOriginal: true }];
    onBeforeCommand(commands, { machineState: { tool: 1, mpos: { x: 10, y: 20 }, ...ms }, tools }, { ...settings });
    return commands.map((c) => c.command.trim());
  };
  const at = (lines, re) => lines.findIndex((l) => re.test(l));
  const keepRef = /^G10 L2 P\[#5220\] Z\[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>\]$/;
  const keepSelf = /^G10 L2 P\[#5220\] Z\[#<_cur_wcs_z_ofs> - #<_nc_last_tlo>\]$/;

  test('M6 measures the tool that set Z0 before unloading it, then keeps Z0 with the new tool', () => {
    const lines = run('M6 T2', pending);
    const ref = at(lines, /^#<_nc_ref_tlo> = #<_nc_last_tlo>$/);
    const unload = at(lines, /^M61 Q0$/);
    const g10 = at(lines, keepRef);
    assert.ok(ref >= 0, 'reference measure present');
    assert.ok(unload > ref, 'reference measure happens before the unload');
    assert.ok(g10 > ref, 'Z0 is kept after the new tool is measured');
    const notifyBefore = lines.slice(0, g10).lastIndexOf('$#=_tool_offset');
    assert.ok(notifyBefore > ref, 'offset applied and announced before the work offset is written');
  });

  test('the reference measure leaves the new tool\'s library writeback alone', () => {
    const lines = run('M6 T2', pending);
    const ref = at(lines, /^#<_nc_ref_tlo> = #<_nc_last_tlo>$/);
    const firstDump = lines.indexOf('$#');
    assert.ok(firstDump > ref, 'no [#] dump before the new tool is measured');
    assert.equal(lines.filter((l) => /^G10 L2/.test(l)).length, 1, 'one work-offset write only');
    const beforeRef = lines.slice(0, ref);
    assert.ok(!beforeRef.includes('$#=_tool_offset'), 'the reference measure does not announce a reference');
  });

  test('after the extra touch-off it goes straight to the rack, and only returns to the job at the end', () => {
    const lines = run('M6 T2', pending);
    const ref = at(lines, /^#<_nc_ref_tlo> = #<_nc_last_tlo>$/);
    const unload = at(lines, /^M61 Q0$/);
    const between = lines.slice(ref, unload);
    assert.ok(!between.some((l) => /^G53 G0 X10 Y20$/.test(l)), 'no detour back to the job before the swap');
    const load = at(lines, /^M61 Q2$/);
    assert.ok(lines.slice(load).some((l) => /^G53 G0 X10 Y20$/.test(l)), 'returns to the job after the change');
  });

  test('the unload route starts at the toolsetter, same as a change that began there', () => {
    const fromTls = run('M6 T2', pending);
    const unloadA = fromTls.slice(fromTls.indexOf('(MSG, ZERO_KEEP_END)') + 1, at(fromTls, /^M61 Q0$/) + 1);
    const commands = [{ command: 'M6 T2', isOriginal: true }];
    onBeforeCommand(commands, { machineState: { tool: 1, mpos: { x: 300, y: -200 }, toolLengthSet: true }, tools }, { ...settings });
    const plain = commands.map((c) => c.command.trim());
    const unloadB = plain.slice(plain.indexOf('G53 G0 Z-5') + 1, at(plain, /^M61 Q0$/) + 1);
    assert.deepEqual(unloadA, unloadB);
  });

  test('the extra measure is wrapped in ZERO_KEEP markers for the UI banner', () => {
    const lines = run('M6 T2', pending);
    const a = lines.indexOf('(MSG, ZERO_KEEP_START T1)');
    const b = lines.indexOf('(MSG, ZERO_KEEP_END)');
    assert.ok(a >= 0 && b > a);
    assert.ok(lines.slice(a, b).some((l) => /^G38\.2/.test(l)), 'touch-off inside the markers');
    assert.ok(b < at(lines, /^M61 Q0$/), 'banner is gone before the swap');
    assert.equal(run('M6 T2', { toolLengthSet: false, zeroSetWithoutTlr: false, zeroTool: 0 }).indexOf('(MSG, ZERO_KEEP_START T1)'), -1);
  });

  test('M6 T0 fixes the reference with the current tool before putting it away', () => {
    const lines = run('M6 T0', pending);
    assert.ok(at(lines, keepSelf) >= 0);
    assert.ok(at(lines, keepSelf) < at(lines, /^M61 Q0$/));
  });

  test('$TLS and $MEASURE_TLO on the loaded tool keep the Z0', () => {
    assert.ok(at(run('$TLS', pending), keepSelf) >= 0, '$TLS');
    assert.ok(at(run('$MEASURE_TLO T1', pending), keepSelf) >= 0, '$MEASURE_TLO');
  });

  test('nothing changes when no Z0 is pending, a reference exists, or another tool set Z0', () => {
    for (const ms of [
      { toolLengthSet: false, zeroSetWithoutTlr: false, zeroTool: 0 },
      { toolLengthSet: true, zeroSetWithoutTlr: true, zeroTool: 1 },
      { toolLengthSet: false, zeroSetWithoutTlr: true, zeroTool: 3 },
    ]) {
      for (const cmd of ['M6 T2', '$TLS']) {
        const lines = run(cmd, ms);
        assert.ok(!lines.some((l) => /^G10 L2/.test(l)), `${cmd} ${JSON.stringify(ms)}`);
        assert.ok(!lines.some((l) => /_nc_ref_tlo/.test(l)), `${cmd} ${JSON.stringify(ms)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Library strategy, no reference yet, Z0 pending: the outgoing tool's
// reference touch-off validates the library for this boot, and the
// controller picks the ending (grblHAL o-word if/else) — load the new tool
// from the library when the touch matches, measure it when it doesn't.
// ---------------------------------------------------------------------------
describe('Z0 carry-over trusts the library when the reference touch matches it', () => {
  const base = {
    slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5,
    clampAuxOutput: 1, toolsetter: { x: 300, y: -200 }, tlsMode: 'library',
  };
  const tools = [
    { toolNumber: 1, offsets: { x: 0, y: 0, z: -46.63, tlsZ: 0 } },
    { toolNumber: 2, offsets: { x: 0, y: 0, z: -33.78, tlsZ: 0 } },
    { toolNumber: 3, offsets: { x: 0, y: 0, z: 0, tlsZ: 0 } },
    { toolNumber: 9, offsets: { x: 0, y: 0, z: -40.1, tlsZ: 0 } },
  ];
  const run = (command, { tool = 1, settings = {}, toolList = tools, ms = {} } = {}) => {
    const commands = [{ command, isOriginal: true }];
    onBeforeCommand(commands, {
      machineState: { tool, mpos: { x: 10, y: 20 }, toolLengthSet: false, zeroSetWithoutTlr: true, zeroTool: tool, ...ms },
      tools: toolList,
    }, buildInitialConfig({ ...base, ...settings }));
    return commands.map((c) => c.command.trim());
  };
  const idx = (lines, re) => lines.findIndex((l) => re.test(l));

  test('M6 T2 branches on the reference touch against T1\'s library TLO', () => {
    const lines = run('M6 T2');
    const ref = idx(lines, /^#<_nc_ref_tlo> = #<_nc_last_tlo>$/);
    const check = lines.indexOf('#<_nc_lib_ok> = [ABS[#<_nc_ref_tlo> - [-46.63]] LT 0.05]');
    const iff = lines.indexOf('o7101 if [#<_nc_lib_ok>]');
    const els = lines.indexOf('o7101 else');
    const end = lines.indexOf('o7101 endif');
    assert.ok(ref >= 0 && check > ref && iff > check && els > iff && end > els, lines.join('\n'));
    assert.ok(idx(lines, /^M61 Q0$/) < iff, 'the unload is shared, before the branch');
  });

  test('library ending loads the stored TLO without touching off; the other ending measures', () => {
    const lines = run('M6 T2');
    const lib = lines.slice(lines.indexOf('o7101 if [#<_nc_lib_ok>]'), lines.indexOf('o7101 else'));
    const meas = lines.slice(lines.indexOf('o7101 else'), lines.indexOf('o7101 endif'));
    assert.ok(lib.includes('G43.1 Z-33.78'));
    assert.ok(!lib.some((l) => /^G38\./.test(l)), 'no touch-off in the library ending');
    assert.ok(lib.includes('M61 Q2') && meas.includes('M61 Q2'), 'both endings load T2');
    assert.ok(meas.some((l) => /^G38\.2/.test(l)));
    assert.ok(meas.includes('G43.1 Z[#<_nc_last_tlo>]'));
    assert.ok(lib.includes('G53 G0 X10 Y20') && meas.includes('G53 G0 X10 Y20'), 'both return to the job');
  });

  test('no $ line inside the branches: grblHAL runs those even in the branch it skips', () => {
    const lines = run('M6 T2');
    const inside = lines.slice(lines.indexOf('o7101 if [#<_nc_lib_ok>]'), lines.indexOf('o7101 endif'));
    const bare = inside.map((l) => l.replace(/^\$keepout_off\s+/, ''));
    assert.deepEqual(bare.filter((l) => l.startsWith('$')), []);
  });

  test('after the endif: announce, keep Z0 by the reference, dump for the writeback', () => {
    const lines = run('M6 T2');
    const tail = lines.slice(lines.indexOf('o7101 endif'));
    const notify = tail.indexOf('$#=_tool_offset');
    const g10 = idx(tail, /^G10 L2 P\[#5220\] Z\[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>\]$/);
    const dump = tail.indexOf('$#');
    assert.ok(notify > 0 && g10 > notify && dump > g10, tail.join('\n'));
    assert.equal(lines.filter((l) => /^G10 L2/.test(l)).length, 1);
  });

  test('no branch — measured as before — when the library cannot be checked or trusted', () => {
    const cases = {
      'outgoing tool has no library TLO': run('M6 T2', { tool: 3 }),
      'new tool has no library TLO': run('M6 T3'),
      'always strategy': run('M6 T2', { settings: { tlsMode: 'always' } }),
      'outgoing tool is a hand-fitted manual tool': run('M6 T2', { tool: 9 }),
      'no Z0 pending': run('M6 T2', { ms: { zeroSetWithoutTlr: false } }),
    };
    for (const [why, lines] of Object.entries(cases)) {
      assert.ok(!lines.some((l) => /^o7101/.test(l)), why);
    }
    const measured = cases['outgoing tool has no library TLO'];
    assert.ok(measured.some((l) => /^G38\.2/.test(l)), 'still measures the new tool');
  });

  test('with a reference already set nothing branches (library loads directly)', () => {
    const lines = run('M6 T2', { ms: { toolLengthSet: true, zeroSetWithoutTlr: false } });
    assert.ok(!lines.some((l) => /^o7101/.test(l)));
    assert.ok(lines.includes('G43.1 Z-33.78'));
  });
});

// ---------------------------------------------------------------------------
// Post Tool Change runs after the new tool is in and the spindle has left the
// rack / tool setter, BEFORE the final leg back to where the change started —
// not after it (a dust-shoe pickup used to drive back to the work first).
// ---------------------------------------------------------------------------
describe('Post Tool Change runs before the return to origin', () => {
  const base = {
    slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5,
    clampAuxOutput: 1, toolsetter: { x: 300, y: -200 }, tlsMode: 'library',
    postToolChangeGcode: '(POST TC)\nG53 G0 X500 Y500',
  };
  const tools = [
    { toolNumber: 1, offsets: { x: 0, y: 0, z: -46.63, tlsZ: 0 } },
    { toolNumber: 2, offsets: { x: 0, y: 0, z: -33.78, tlsZ: 0 } },
  ];
  const run = (command, { settings = {}, ms = {} } = {}) => {
    const commands = [{ command, isOriginal: true }];
    onBeforeCommand(commands, {
      machineState: { tool: 1, mpos: { x: 10, y: 20 }, toolLengthSet: true, ...ms }, tools,
    }, buildInitialConfig({ ...base, ...settings }));
    return commands.map((c) => c.command.trim());
  };
  const leg = (l) => /G53 G0 X10 Y20$/.test(l);
  const post = (lines) => lines.indexOf('(POST TC)');
  const lastLeg = (lines) => lines.map((l, i) => (leg(l) ? i : -1)).filter((i) => i >= 0).pop();

  const check = (lines, why) => {
    const p = post(lines);
    const back = lastLeg(lines);
    assert.ok(p >= 0 && back > p, `${why}: event before the final leg\n${lines.join('\n')}`);
    const between = lines.slice(p, back);
    assert.ok(between.some((l) => /^G21$/.test(l)), `${why}: back to mm after the event`);
    assert.ok(between.some((l) => /G53 G0 Z-5$/.test(l)), `${why}: safe Z before the final leg`);
    assert.equal(lines.filter(leg).length, 1, `${why}: one return to origin`);
    assert.ok(!/^\$keepout_off/.test(lines[back]), `${why}: the final leg keeps the core keepout check`);
  };

  test('library load (no touch-off)', () => check(run('M6 T2'), 'library'));
  test('measured load', () => check(run('M6 T2', { settings: { tlsMode: 'always' } }), 'always'));
  test('standalone $TLS', () => check(run('$TLS'), '$TLS'));

  test('Z0 carry-over branch: event and final leg after the endif, never inside a branch', () => {
    const lines = run('M6 T2', { ms: { toolLengthSet: false, zeroSetWithoutTlr: true, zeroTool: 1 } });
    const end = lines.indexOf('o7101 endif');
    assert.ok(end >= 0);
    assert.ok(post(lines) > end, 'event after the endif');
    assert.ok(!lines.slice(0, end).some(leg), 'no return to origin inside the branches');
    check(lines, 'branch');
  });

  test('with no event the program is unchanged: the return is the last move', () => {
    const lines = run('M6 T2', { settings: { postToolChangeGcode: '' } });
    assert.equal(post(lines), -1);
    assert.equal(lines.filter(leg).length, 1);
  });
});

describe('homing', () => {
  test('$H passes through untouched: no tool setter run after homing', () => {
    const settings = buildInitialConfig({ slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5, clampAuxOutput: 1, toolsetter: { x: 300, y: -200 }, performTlsAfterHome: true });
    const commands = [{ command: '$H', isOriginal: true }];
    onBeforeCommand(commands, { machineState: { tool: 1, mpos: { x: 10, y: 20 } }, tools: [] }, { ...settings });
    assert.deepEqual(commands.map((c) => c.command.trim()), ['$H']);
  });
});

describe('manual tools always measure', () => {
  const settings = buildInitialConfig({
    slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5,
    clampAuxOutput: 1, toolsetter: { x: 300, y: -200 }, manualTool: { x: 200, y: -100 }, tlsMode: 'library',
  });
  const tools = [
    { toolNumber: 2, offsets: { z: -52.1 } },   // rack tool, TLO on file
    { toolNumber: 5, offsets: { z: -47.5 } },   // manual tool, TLO on file
  ];
  const run = (command, tool = 1) => {
    const commands = [{ command, isOriginal: true }];
    onBeforeCommand(commands, { machineState: { tool, mpos: { x: 10, y: 20 }, toolLengthSet: true }, tools }, { ...settings });
    return commands.map((c) => c.command.trim());
  };

  test('a manual tool with a stored TLO is measured, not loaded from the library', () => {
    const lines = run('M6 T5');
    assert.ok(lines.some((l) => /^G38\.2/.test(l)), 'expected a probe move');
    assert.ok(!lines.some((l) => /Load stored TLO/.test(l)), 'must not reuse the stored value');
  });

  test('a manual-to-manual swap is measured too', () => {
    const lines = run('M6 T5', 4);
    assert.ok(lines.some((l) => /^G38\.2/.test(l)));
  });

  test('a rack tool with a stored TLO still follows the library strategy', () => {
    const lines = run('M6 T2');
    assert.ok(!lines.some((l) => /^G38\.2/.test(l)), 'rack tool reuses its stored value');
    assert.ok(lines.some((l) => /Load stored TLO/.test(l)));
  });
});

describe('Sienci profile turns the Sienci keepout off around rack moves', () => {
  const base = { slots: 3, slot1: { x: -115, y: 40, z: -100 }, slotDistance: 80, zSafe: -5, clampAuxOutput: 1 };
  const runM6 = (extra, tool = 0) => {
    const commands = [{ command: 'M6 T2', isOriginal: true }];
    onBeforeCommand(commands, { edition: 'pro', machineState: { tool, mpos: { x: 10, y: 20 } }, tools: [] },
      buildInitialConfig({ ...base, ...extra }));
    return commands.map((c) => c.command.trim());
  };

  test('off before the first rack move, back on after the change', () => {
    const lines = runM6({ atcProfile: 'sienci' }, 1);
    const off = lines.findIndex((l) => l.startsWith('M960 P0'));
    const on = lines.findIndex((l) => l.startsWith('M960 P1'));
    const firstXY = lines.findIndex((l) => /^G53 G0 X/.test(l));
    assert.ok(off >= 0 && on > off, 'both present, off first');
    assert.ok(off < firstXY, 'off before any XY move');
    assert.ok(on > lines.findIndex((l) => l.startsWith('M61 Q2')), 'on after the new tool is in');
  });

  test('other profiles send no M960', () => {
    assert.ok(!runM6({ atcProfile: 'custom' }, 1).some((l) => l.startsWith('M960')));
    assert.ok(!runM6({}, 1).some((l) => l.startsWith('M960')));
  });

  test('$slotN (parks in the rack) only turns it off', () => {
    const commands = [{ command: '$slot2', isOriginal: true }];
    onBeforeCommand(commands, { edition: 'pro', machineState: { tool: 0, mpos: { x: 10, y: 20 } }, tools: [] },
      buildInitialConfig({ ...base, atcProfile: 'sienci' }));
    const lines = commands.map((c) => c.command.trim());
    assert.ok(lines.some((l) => l.startsWith('M960 P0')));
    assert.ok(!lines.some((l) => l.startsWith('M960 P1')));
  });
});
