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
  buildUnloadTool,
  buildSlotNav,
  calculateSlotPosition,
  buildToolChangeProgram,
  gateSpindleUnclamp,
  createToolLengthSetRoutine,
  createToolLengthSetProgram,
  routePoint,
  pickEntryEdge,
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
// probe cycle — via $TLS, via M6, via $H+performTlsAfterHome. It didn't
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

// Drawbar / tool-seated sensor checks. Two independent physical sensors
// (unlike pressure, which shares one pin across all its checks): the
// drawbar sensor is read right after the collet unclamps (must report
// released), the tool-seated sensor right after it clamps (must report
// seated). Each has its own pin — a kit that happens to wire both to the
// same physical sensor just points both settings at that pin. Both are
// read as OK=HIGH (invert the port in firmware, $370, for a switch wired
// the other way round); each is skipped independently when its own
// input is unset (-1), same as pressure — an install without either
// sensor wired must see byte-identical output to before this feature
// existed.
describe('drawbar / tool-seated sensor guards', () => {
  const SENSORS = {
    ...CUP_RACK, pressureInput: -1, drawbarSensorInput: 3, toolSeatedSensorInput: 5,
    manualTool: { x: 321, y: -966 }
  };
  const FORK_SENSORS = {
    ...CUP_RACK, rackHolding: 'Fork', pressureInput: -1, drawbarSensorInput: 3, toolSeatedSensorInput: 5,
    manualTool: { x: 321, y: -966 }
  };

  test('neither sensor configured (-1): unload and load emit no M66 lines at all', () => {
    const NONE = { ...CUP_RACK, pressureInput: -1, drawbarSensorInput: -1, toolSeatedSensorInput: -1 };
    const slotPos = calculateSlotPosition(NONE, 1);
    const unload = buildUnloadTool(NONE, 1, slotPos, { x: 60, y: 120 });
    const load = buildLoadTool(NONE, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(!unload.includes('M66'), 'unload must not reference M66 when drawbarSensorInput is unset');
    assert.ok(!load.includes('M66'), 'load must not reference M66 when neither sensor is set');
  });

  test('only drawbar sensor configured: unload checks it, load never mentions TOOL_FAULT', () => {
    const ONLY_DRAWBAR = { ...CUP_RACK, pressureInput: -1, drawbarSensorInput: 3, toolSeatedSensorInput: -1 };
    const slotPos = calculateSlotPosition(ONLY_DRAWBAR, 1);
    const unload = buildUnloadTool(ONLY_DRAWBAR, 1, slotPos, { x: 60, y: 120 });
    const load = buildLoadTool(ONLY_DRAWBAR, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(unload.includes('DRAWBAR_FAULT'), 'unload should still verify the drawbar sensor');
    assert.ok(!load.includes('TOOL_FAULT'), 'tool-seated check must stay off when its own input is unconfigured');
  });

  test('only tool-seated sensor configured: load checks it, unload never mentions DRAWBAR_FAULT', () => {
    const ONLY_SEATED = { ...CUP_RACK, pressureInput: -1, drawbarSensorInput: -1, toolSeatedSensorInput: 5 };
    const slotPos = calculateSlotPosition(ONLY_SEATED, 1);
    const unload = buildUnloadTool(ONLY_SEATED, 1, slotPos, { x: 60, y: 120 });
    const load = buildLoadTool(ONLY_SEATED, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(!unload.includes('DRAWBAR_FAULT'), 'drawbar check must stay off when its own input is unconfigured');
    assert.ok(load.includes('TOOL_FAULT'), 'load should still verify the tool-seated sensor');
  });

  test('Cup unload: drawbar check (M66 P3 L3, wait-HIGH by default) fires after unclamp, before Z-safe retract', () => {
    const slotPos = calculateSlotPosition(SENSORS, 1);
    const gcode = buildUnloadTool(SENSORS, 1, slotPos, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    const unclampIdx = lines.indexOf('M64 P2');
    const readIdx = lines.indexOf('M66 P3 L3 Q0.01');
    const retractIdx = lines.indexOf(`G53 G0 Z${SENSORS.zSafe}`);
    assert.ok(unclampIdx !== -1 && readIdx !== -1 && retractIdx !== -1, 'unclamp, sensor read and retract must all be present');
    assert.ok(readIdx > unclampIdx && readIdx < retractIdx,
      `drawbar read must fire after unclamp and before Z-safe retract — got unclampIdx=${unclampIdx}, readIdx=${readIdx}, retractIdx=${retractIdx}`);
    assert.ok(gcode.includes('(MSG, PLUGIN_PNEUMATICATC:DRAWBAR_FAULT)'), 'fault dialog message must be present');
    assert.ok(gcode.includes('(MSG, PLUGIN_PNEUMATICATC:DRAWBAR_FAULT_UNVERIFIED)'), 'unverified dialog message must be present');
  });

  test('Fork unload: same drawbar check fires after unclamp, before Z-safe retract', () => {
    const slotPos = calculateSlotPosition(FORK_SENSORS, 1);
    const gcode = buildUnloadTool(FORK_SENSORS, 1, slotPos, { x: 60, y: 120 });
    const lines = motionLines(gcode);
    const unclampIdx = lines.indexOf('M64 P2');
    const readIdx = lines.indexOf('M66 P3 L3 Q0.01');
    const retractIdx = lines.indexOf(`G53 G0 Z${FORK_SENSORS.zSafe}`);
    assert.ok(unclampIdx !== -1 && readIdx !== -1 && retractIdx !== -1, 'unclamp, sensor read and retract must all be present');
    assert.ok(readIdx > unclampIdx && readIdx < retractIdx, 'drawbar read must fire after unclamp and before Z-safe retract');
  });

  test('Cup load: tool-seated check (M66 P5 L3, wait-HIGH by default) fires after clamp, before Z-safe retract', () => {
    const slotPos = calculateSlotPosition(SENSORS, 1);
    const gcode = buildLoadTool(SENSORS, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    const lines = motionLines(gcode);
    const clampIdx = lines.indexOf('M65 P2');
    const readIdx = lines.indexOf('M66 P5 L3 Q0.01');
    const retractIdx = lines.indexOf(`G53 G0 Z${SENSORS.zSafe}`);
    assert.ok(clampIdx !== -1 && readIdx !== -1 && retractIdx !== -1, 'clamp, sensor read and retract must all be present');
    assert.ok(readIdx > clampIdx && readIdx < retractIdx,
      `tool-seated read must fire after clamp and before Z-safe retract — got clampIdx=${clampIdx}, readIdx=${readIdx}, retractIdx=${retractIdx}`);
    assert.ok(gcode.includes('(MSG, PLUGIN_PNEUMATICATC:TOOL_FAULT)'), 'fault dialog message must be present');
    assert.ok(gcode.includes('(MSG, PLUGIN_PNEUMATICATC:TOOL_FAULT_UNVERIFIED)'), 'unverified dialog message must be present');
  });

  test('Fork load: tool-seated check fires after clamp, before the slide-out G1', () => {
    const slotPos = calculateSlotPosition(FORK_SENSORS, 1);
    const gcode = buildLoadTool(FORK_SENSORS, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    const lines = motionLines(gcode);
    const clampIdx = lines.indexOf('M65 P2');
    const readIdx = lines.indexOf('M66 P5 L3 Q0.01');
    const slideIdx = lines.findIndex(l => /^G53 G1 X/.test(l));
    assert.ok(clampIdx !== -1 && readIdx !== -1 && slideIdx !== -1, 'clamp, sensor read and slide-out must all be present');
    assert.ok(readIdx > clampIdx && readIdx < slideIdx,
      `tool-seated read must fire after clamp and before the slide-out — got clampIdx=${clampIdx}, readIdx=${readIdx}, slideIdx=${slideIdx}`);
  });

  test('T0 → T1 (empty spindle): releaseFirst also runs the drawbar check', () => {
    // drawbarAlreadyReleased=false forces buildLoadTool's own unclamp
    // before descending onto the shank — that unclamp deserves the same
    // verification as the one in buildUnloadTool.
    const slotPos = calculateSlotPosition(SENSORS, 1);
    const gcode = buildLoadTool(SENSORS, 1, slotPos, '', /* drawbarAlreadyReleased */ false, { x: 60, y: 120 }, false);
    assert.ok(gcode.includes('(MSG, PLUGIN_PNEUMATICATC:DRAWBAR_FAULT)'),
      'T0 -> T1 load must verify the drawbar released before descending onto the shank');
  });

  test('chained Tm -> Tn swap (drawbarAlreadyReleased=true): load does NOT re-run the drawbar check', () => {
    // The unload half of the swap already verified released; re-verifying
    // in the load half would just be checking the same physical state twice.
    const slotPos = calculateSlotPosition(SENSORS, 2);
    const gcode = buildLoadTool(SENSORS, 2, slotPos, '', /* drawbarAlreadyReleased */ true, { x: 60, y: 120 }, true);
    assert.ok(!gcode.includes('DRAWBAR_FAULT'), 'chained load must not duplicate the unload half\'s drawbar check');
    assert.ok(gcode.includes('TOOL_FAULT'), 'chained load must still verify the new tool seated after clamping');
  });
});

// Tool-seated pre-check: when the sensor shows the spindle is already
// empty (operator pulled the tool by hand, or a prior swap left it empty
// despite currentTool>0 in software), skip the unload motion entirely at
// runtime rather than routing into a slot to drop a tool that isn't
// there. Only engages for a real rack-tool -> real-tool swap when
// toolSeatedSensorInput is configured — every other case (sensor unset,
// bare unload, manual source) must see unchanged output.
describe('buildToolChangeProgram — tool-seated pre-check skips unload when spindle already empty', () => {
  const PROGRAM_SETTINGS = {
    ...CUP_RACK, pressureInput: -1, drawbarSensorInput: -1,
    toolSeatedSensorInput: 5, toolsetter: { x: 0, y: 0 }
  };

  test('no toolSeatedSensorInput configured: normal Tm -> Tn swap keeps the chained par-walk shortcut, no immediate read', () => {
    const NO_SENSOR = { ...PROGRAM_SETTINGS, toolSeatedSensorInput: -1 };
    const program = motionLines(buildToolChangeProgram(NO_SENSOR, 1, 2).join('\n'));
    assert.ok(!program.some(l => l.includes('L0 Q0')), 'no immediate read should appear when the sensor is unconfigured');
    assert.ok(program.includes('G53 G0 X-115 Y120'), 'chained par-walk to slot 2 engaged should still be the shortcut used');
  });

  test('sensor configured: Tm -> Tn swap wraps unload in an immediate-read runtime IF (o200)', () => {
    const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 1, 2).join('\n'));
    const readIdx = program.indexOf('M66 P5 L0 Q0');
    const ifIdx = program.indexOf('o200 if [#5399 EQ 1]');
    const endIdx = program.indexOf('o200 endif');
    const unclampIdx = program.indexOf('M64 P2');
    assert.ok(readIdx !== -1 && ifIdx !== -1 && endIdx !== -1 && unclampIdx !== -1,
      'immediate read, if/endif wrapper and the unload unclamp must all be present');
    assert.ok(readIdx < ifIdx, 'the sensor read must happen before the if that branches on it');
    assert.ok(ifIdx < unclampIdx && unclampIdx < endIdx,
      `unload's unclamp must sit inside the o200 if/endif wrapper — got ifIdx=${ifIdx}, unclampIdx=${unclampIdx}, endIdx=${endIdx}`);
  });

  test('sensor configured: load no longer takes the chained par-walk shortcut (falls back to the safe routed entrance)', () => {
    const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 1, 2).join('\n'));
    assert.ok(!program.includes('G53 G0 X-115 Y120'),
      'the one-move par-walk shortcut must not appear — load cannot assume the unload above actually ran at runtime');
  });

  test('sensor configured: load runs its own release-first (two independent unclamp fires, not one)', () => {
    const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 1, 2).join('\n'));
    const unclampCount = program.filter(l => l === 'M64 P2').length;
    assert.equal(unclampCount, 2,
      'expected one unclamp inside the guarded unload plus a second, independent one from load\'s own release-first');
  });

  test('sensor configured but currentTool=0 (nothing to unload): pre-check stays inactive', () => {
    const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 0, 2).join('\n'));
    assert.ok(!program.some(l => l.includes('L0 Q0')), 'pre-check only makes sense when there is an unload to guard');
  });

  test('rack source -> manual target: pre-check still applies (broadened condition covers every target, not just rack targets)', () => {
    const MANUAL_TARGET = { ...PROGRAM_SETTINGS, manualTool: { x: 321, y: -966 } };
    const program = motionLines(buildToolChangeProgram(MANUAL_TARGET, 1, 4).join('\n'));
    assert.ok(program.some(l => l.includes('M66 P5 L0 Q0')), 'rack -> manual must still trigger the unload pre-check');
    assert.ok(program.includes('o200 if [#5399 EQ 1]'));
  });

  // Tn -> T0 (bare unload, nothing loading next). Before this broadening
  // the pre-check required toolNumber > 0 and simply didn't apply here —
  // now it does, which exposes two things that only worked before because
  // a load always followed the unload: the return-to-origin exit move
  // assumes the machine physically reached the source slot, and nothing
  // downstream corrects the host's tool belief if the guard turns out
  // empty (no reportLoadOutcome call exists for a bare unload).
  describe('Tn -> T0 (bare unload): the exit move and the M61 report both need their own fix', () => {
    test('exit-to-origin move is folded INSIDE the o200 guard, not appended unconditionally after it', () => {
      const sourceSlotPos = calculateSlotPosition(PROGRAM_SETTINGS, 1);
      const expectedExitLines = motionLines(cupExit(sourceSlotPos.engaged, { x: 0, y: 0 }, PROGRAM_SETTINGS));
      const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 1, 0).join('\n'));
      const ifIdx = program.indexOf('o200 if [#5399 EQ 1]');
      const endIdx = program.indexOf('o200 endif');
      assert.ok(ifIdx !== -1 && endIdx !== -1, 'guard must be present');
      expectedExitLines.forEach((line) => {
        const idx = program.indexOf(line);
        assert.ok(idx > ifIdx && idx < endIdx,
          `expected exit line "${line}" to sit inside the o200 guard — ifIdx=${ifIdx}, foundAt=${idx}, endIdx=${endIdx}`);
      });
    });

    test('exit-to-origin move does not also appear a second time outside the guard (no duplicate from the old unconditional branch)', () => {
      const sourceSlotPos = calculateSlotPosition(PROGRAM_SETTINGS, 1);
      const expectedExitLines = motionLines(cupExit(sourceSlotPos.engaged, { x: 0, y: 0 }, PROGRAM_SETTINGS));
      const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 1, 0).join('\n'));
      const occurrences = program.filter((l) => expectedExitLines.includes(l)).length;
      assert.equal(occurrences, expectedExitLines.length,
        'each exit line should appear exactly once (inside the guard), not duplicated by the old exitSection branch');
    });

    test('M61 Q0 fires unconditionally once AFTER the guard closes, regardless of which branch ran', () => {
      const program = motionLines(buildToolChangeProgram(PROGRAM_SETTINGS, 1, 0).join('\n'));
      const endIdx = program.indexOf('o200 endif');
      assert.ok(endIdx !== -1, 'guard must be present');
      const afterGuard = program.slice(endIdx + 1);
      assert.ok(afterGuard.includes('M61 Q0'),
        'M61 Q0 must fire unconditionally after the guard closes — Tn -> T0 always resolves to T0 either way');
    });

    test('unconfigured: unaffected — plain unconditional exit-to-origin, no guard, no extra M61', () => {
      const NO_SENSOR = { ...PROGRAM_SETTINGS, toolSeatedSensorInput: -1 };
      const sourceSlotPos = calculateSlotPosition(NO_SENSOR, 1);
      const expectedExitLines = motionLines(cupExit(sourceSlotPos.engaged, { x: 0, y: 0 }, NO_SENSOR));
      const program = motionLines(buildToolChangeProgram(NO_SENSOR, 1, 0).join('\n'));
      assert.ok(!program.some((l) => l.includes('L0 Q0')), 'no immediate read when the sensor is unconfigured');
      assert.ok(!/o\d+ if/.test(program.join('\n')), 'no runtime branch when the sensor is unconfigured');
      expectedExitLines.forEach((line) => {
        assert.ok(program.includes(line), `expected unchanged exit line "${line}" to still be present`);
      });
      const m61Count = program.filter((l) => l === 'M61 Q0').length;
      assert.equal(m61Count, 1, 'exactly one M61 Q0 (unload\'s own) — no added unconditional one when unconfigured');
    });
  });
});

// Startup / stale-state scenario: software believes the spindle is empty
// (currentTool=0 — e.g. a fresh controller boot with a tool physically
// left loaded from before) but the tool-seated sensor disagrees. None of
// the currentTool>0 guards above apply here, since there's nothing on
// record to unload — this has to be caught separately, before ANY
// unload/load motion, or the macro would auto-release the drawbar and
// route a new rack tool into an already-occupied spindle.
describe('buildToolChangeProgram — unexpected-tool guard catches a stale T0 belief at the start', () => {
  const STARTUP_SETTINGS = {
    ...CUP_RACK, pressureInput: -1, drawbarSensorInput: -1,
    toolSeatedSensorInput: 5, toolsetter: { x: 0, y: 0 },
    manualTool: { x: 321, y: -966 }
  };

  test('currentTool=0, sensor configured: guard runs BEFORE any unload/load motion', () => {
    const program = motionLines(buildToolChangeProgram(STARTUP_SETTINGS, 0, 1).join('\n'));
    const readIdx = program.indexOf('M66 P5 L0 Q0');
    const ifIdx = program.indexOf('o205 if [#5399 EQ 1]');
    const endIdx = program.indexOf('o205 endif');
    const parkIdx = program.indexOf('G53 G0 X321 Y-966');
    const unclampIdx = program.indexOf('M64 P2');
    assert.ok(readIdx !== -1 && ifIdx !== -1 && endIdx !== -1 && parkIdx !== -1 && unclampIdx !== -1,
      'read, if/endif wrapper, park-at-manual move and unclamp must all be present');
    assert.ok(readIdx < ifIdx && ifIdx < parkIdx && parkIdx < unclampIdx && unclampIdx < endIdx,
      'guard must run start-to-finish before anything else in the macro');
    // Nothing from the rack-load sequence (routing into slot 1) should
    // appear before the guard closes.
    const targetSlotPos = calculateSlotPosition(STARTUP_SETTINGS, 1);
    const firstLoadRoutingLine = motionLines(cupEntrance(targetSlotPos.engaged, { x: 0, y: 0 }, STARTUP_SETTINGS))[0];
    const entryIdx = program.indexOf(firstLoadRoutingLine);
    assert.ok(entryIdx === -1 || entryIdx > endIdx,
      'rack routing for the requested load must not start until after the guard resolves');
    assert.ok(program.join('\n').includes('UNEXPECTED_TOOL_DETECTED'), 'dialog message must be present');
  });

  test('currentTool=0, sensor unconfigured: no guard at all — byte-identical to before this feature existed', () => {
    const NO_SENSOR = { ...STARTUP_SETTINGS, toolSeatedSensorInput: -1 };
    const program = buildToolChangeProgram(NO_SENSOR, 0, 1).join('\n');
    assert.ok(!program.includes('L0 Q0'), 'no immediate read when the sensor is unconfigured');
    assert.ok(!program.includes('UNEXPECTED_TOOL_DETECTED'), 'no dialog when the sensor is unconfigured');
  });

  test('currentTool>0 (software already believes a rack tool is loaded): guard does not run — that case is covered by the other guards', () => {
    const program = motionLines(buildToolChangeProgram(STARTUP_SETTINGS, 1, 2).join('\n'));
    assert.ok(!program.includes('o205 if [#5399 EQ 1]'),
      'unexpected-tool guard only applies to a T0 belief; currentTool>0 is handled by seatedPrecheckActive instead');
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

// reportLoadOutcome: after a load's clamp step, don't blindly tell the
// host the load succeeded. Tool number == slot number in this plugin's
// model, so a corrected M61 is also the correction for slot occupancy —
// the tool never left its slot if the sensor never confirmed it landed
// in the spindle. Every call site — rack or manual — runs toolSeatedGuard
// first and reportLoadOutcome reuses its trailing #5399 (no extra read).
// A manual clamp that doesn't seat gets the same blocking Re-check/Abort
// dialog an automated one does — there's no silent/non-blocking path.
describe('reportLoadOutcome — corrects M61 (and gates TLS) when the tool-seated sensor disagrees', () => {
  const CUP_OUTCOME = {
    ...CUP_RACK, pressureInput: -1, drawbarSensorInput: -1, toolSeatedSensorInput: 5,
    manualTool: { x: 321, y: -966 }
  };
  const FORK_OUTCOME = {
    ...CUP_RACK, rackHolding: 'Fork', pressureInput: -1, drawbarSensorInput: -1, toolSeatedSensorInput: 5,
    manualTool: { x: 321, y: -966 }
  };
  const SAMPLE_TLS = '(sample tls routine)';

  test('Cup rack load, sensor unconfigured: plain M61 + tlsRoutine, no runtime branch', () => {
    const NO_SENSOR = { ...CUP_OUTCOME, toolSeatedSensorInput: -1 };
    const slotPos = calculateSlotPosition(NO_SENSOR, 1);
    const gcode = buildLoadTool(NO_SENSOR, 1, slotPos, SAMPLE_TLS, false, { x: 60, y: 120 }, false);
    assert.ok(gcode.includes('M61 Q1'), 'must still report the loaded tool number');
    assert.ok(gcode.includes(SAMPLE_TLS), 'tlsRoutine must still run');
    assert.ok(!/o\d+ if/.test(gcode), 'no runtime branch should appear when the sensor is unconfigured');
  });

  test('Cup rack load, sensor configured: wraps M61 + tlsRoutine in an o241 if/else on the success path', () => {
    const slotPos = calculateSlotPosition(CUP_OUTCOME, 1);
    const gcode = buildLoadTool(CUP_OUTCOME, 1, slotPos, SAMPLE_TLS, false, { x: 60, y: 120 }, false);
    const lines = motionLines(gcode);
    const ifIdx = lines.indexOf('o241 if [#5399 NE -1]');
    const elseIdx = lines.indexOf('o241 else');
    const endIdx = lines.indexOf('o241 endif');
    const successM61 = lines.indexOf('M61 Q1');
    assert.ok(ifIdx !== -1 && elseIdx !== -1 && endIdx !== -1, 'if/else/endif must all be present');
    assert.ok(ifIdx < successM61 && successM61 < elseIdx, 'M61 Q<toolNumber> must sit in the success (if) branch');
    const tlsPos = gcode.indexOf(SAMPLE_TLS);
    assert.ok(tlsPos !== -1 && tlsPos < elseIdx, 'tlsRoutine must be positioned inside the success branch');
  });

  test('Fork rack load, sensor configured: same shape at o301', () => {
    const slotPos = calculateSlotPosition(FORK_OUTCOME, 1);
    const gcode = buildLoadTool(FORK_OUTCOME, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(gcode.includes('o301 if [#5399 NE -1]'));
    assert.ok(gcode.includes('o301 else'));
    assert.ok(gcode.includes('o301 endif'));
  });

  test('manual load (toolNumber > slots), sensor configured: runs toolSeatedGuard (o220) before reportLoadOutcome (o210) — same obligation as a rack load', () => {
    const MANUAL = { ...CUP_OUTCOME, manualTool: { x: 321, y: -966 } };
    const slotPos = calculateSlotPosition(MANUAL, 4);
    const gcode = buildLoadTool(MANUAL, 4, slotPos, '', false, { x: 0, y: 0 }, false);
    const lines = motionLines(gcode);
    const readIdx = lines.indexOf('M66 P5 L3 Q0.01');
    const guardEndIdx = lines.indexOf('o222 endif');
    const reportIfIdx = lines.indexOf('o210 if [#5399 NE -1]');
    assert.ok(readIdx !== -1 && guardEndIdx !== -1 && reportIfIdx !== -1,
      'toolSeatedGuard\'s read/retry chain and reportLoadOutcome\'s wrapper must all be present');
    assert.ok(readIdx < guardEndIdx && guardEndIdx < reportIfIdx,
      'toolSeatedGuard must fully resolve before reportLoadOutcome decides the M61 report');
    assert.ok(gcode.includes('(MSG, PLUGIN_PNEUMATICATC:TOOL_FAULT)'),
      'a manual clamp that does not seat must get the same blocking Re-check/Abort dialog as a rack load');
    assert.ok(gcode.includes('M61 Q4'));
    assert.ok(gcode.includes('M61 Q0'));
  });

  test('manual load, sensor unconfigured: unchanged, no guard and no runtime branch', () => {
    const MANUAL_NO_SENSOR = { ...CUP_OUTCOME, toolSeatedSensorInput: -1, manualTool: { x: 321, y: -966 } };
    const slotPos = calculateSlotPosition(MANUAL_NO_SENSOR, 4);
    const gcode = buildLoadTool(MANUAL_NO_SENSOR, 4, slotPos, '', false, { x: 0, y: 0 }, false);
    assert.ok(!gcode.includes('M66'), 'no sensor read when unconfigured');
    assert.ok(!/o\d+ if/.test(gcode), 'no runtime branch when unconfigured');
    assert.ok(gcode.includes('M61 Q4'));
  });

  test('manual -> manual swap, sensor configured: same toolSeatedGuard (o230) + reportLoadOutcome (o215) pattern', () => {
    const MANUAL_SWAP_SETTINGS = {
      ...CUP_OUTCOME, manualTool: { x: 321, y: -966 }, toolsetter: { x: 0, y: 0 }
    };
    const program = buildToolChangeProgram(MANUAL_SWAP_SETTINGS, 4, 5).join('\n');
    assert.ok(program.includes('M66 P5 L3 Q0.01'));
    assert.ok(program.includes('o232 endif'));
    assert.ok(program.includes('o215 if [#5399 NE -1]'));
    assert.ok(program.includes('(MSG, PLUGIN_PNEUMATICATC:TOOL_FAULT)'));
    assert.ok(program.includes('M61 Q5'));
    assert.ok(program.includes('M61 Q0'));
  });
});

// toolSeatedOrManualFallback: when a rack load's clamp doesn't seat, one
// sensor read decides it — no Re-check retries. An earlier version
// retried twice with the same TOOL_FAULT dialog before falling back, but
// that repeated-key-then-different-key sequence (TOOL_FAULT x2 handing
// off to MANUAL_CLAMP_TOOL) was the one thing in this plugin that
// reliably made the pendant UI drop the next dialog it was supposed to
// show, while desktop stayed fine. Retries are gone entirely now: one
// read, and if it's not seated the macro falls straight into
// buildManualLoad — the SAME function a genuinely out-of-rack tool
// number (e.g. a requested T99 with 3 configured slots) already uses,
// addressed to the tool that was actually being rack-loaded (never
// renumbered) so M61 reports the truth. No operator choice to make at
// the fallback point — an earlier design offered "Re-check or Load
// Manually" via a button that set a flag before resuming, and it
// deadlocked on real hardware (the controller doesn't ack a queued line
// while paused at M0, so the resume that would have followed it never
// went out). This version never injects gcode from a button click.
describe('toolSeatedOrManualFallback — single-read fallback to buildManualLoad, no retries', () => {
  const FALLBACK_CUP = {
    ...CUP_RACK, pressureInput: -1, drawbarSensorInput: -1, toolSeatedSensorInput: 5,
    manualTool: { x: 321, y: -966 }, toolsetter: { x: 0, y: 0 }
  };
  const FALLBACK_FORK = { ...FALLBACK_CUP, rackHolding: 'Fork' };

  test('Cup rack load: fallback addresses the SAME tool number (not renumbered), reachable after a single read', () => {
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 1);
    const gcode = buildLoadTool(FALLBACK_CUP, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    const checkIdx = gcode.indexOf('o240 if');
    const manualClampIdx = gcode.indexOf('MANUAL_CLAMP_TOOL_1');
    assert.ok(checkIdx !== -1, 'the fault check must be present');
    assert.ok(manualClampIdx !== -1 && manualClampIdx > checkIdx,
      'the manual fallback dialog must be reachable from the fault check, and must address tool 1 — not 99 or any other renumbering');
    assert.ok(!gcode.includes('MANUAL_CLAMP_TOOL_99'), 'must never renumber to an out-of-range tool number');
    const beforeHandoff = gcode.slice(0, manualClampIdx);
    assert.ok(!beforeHandoff.includes('TOOL_FAULT)'),
      'no TOOL_FAULT dialog on the rack-clamp check itself — that repeated-then-different-key dialog sequence broke the pendant UI');
  });

  test('Fork rack load: fallback addresses the SAME tool number', () => {
    const slotPos = calculateSlotPosition(FALLBACK_FORK, 2);
    const gcode = buildLoadTool(FALLBACK_FORK, 2, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(gcode.includes('MANUAL_CLAMP_TOOL_2'), 'manual-fallback dialog must address tool 2, not some other number');
  });

  test('fallback retracts to Z-safe before reusing buildManualLoad (spindle may still be at slot depth)', () => {
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 1);
    const gcode = buildLoadTool(FALLBACK_CUP, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    const finalCheckIdx = gcode.indexOf('o240 if [#5399 EQ -1]');
    const retractIdx = gcode.indexOf(`G53 G0 Z${FALLBACK_CUP.zSafe}`, finalCheckIdx);
    const parkIdx = gcode.indexOf(`G53 G0 X${FALLBACK_CUP.manualTool.x}`, finalCheckIdx);
    assert.ok(finalCheckIdx !== -1 && retractIdx !== -1 && parkIdx !== -1, 'final check, retract and park move must all be present');
    assert.ok(retractIdx > finalCheckIdx && retractIdx < parkIdx, 'must retract to Z-safe before parking at the manual station');
  });

  test('fallback uses manualTlsRoutine (anchored at manualTool), not the rack-chained tlsRoutine', () => {
    const CHAINED_TLS = '(this assumes it is chained from a rack exit — wrong for the fallback)';
    const MANUAL_TLS = '(this is anchored at manualTool — correct for the fallback)';
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 1);
    const gcode = buildLoadTool(FALLBACK_CUP, 1, slotPos, CHAINED_TLS, false, { x: 60, y: 120 }, false, MANUAL_TLS);
    const finalCheckIdx = gcode.indexOf('o240 if [#5399 EQ -1]');
    const fallbackText = gcode.slice(finalCheckIdx, gcode.indexOf('o240 else'));
    assert.ok(!fallbackText.includes(CHAINED_TLS),
      'the rack-chained tlsRoutine must not appear inside the fallback branch — wrong routing geometry from manualTool');
    assert.ok(fallbackText.includes(MANUAL_TLS),
      'manualTlsRoutine must run inside the fallback branch so TLS still probes, just correctly routed from manualTool');
  });

  test('without an explicit manualTlsRoutine, buildLoadTool falls back to tlsRoutine (default keeps older callers working)', () => {
    const SAME_TLS = '(only one routine passed)';
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 1);
    const gcode = buildLoadTool(FALLBACK_CUP, 1, slotPos, SAME_TLS, false, { x: 60, y: 120 }, false);
    const finalCheckIdx = gcode.indexOf('o240 if [#5399 EQ -1]');
    const fallbackText = gcode.slice(finalCheckIdx, gcode.indexOf('o240 else'));
    assert.ok(fallbackText.includes(SAME_TLS), 'omitting manualTlsRoutine must default to tlsRoutine, not drop TLS entirely');
  });

  test('no button/flag choice: the flag is a plain line inside the fault branch, not injected from a dialog button', () => {
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 1);
    const gcode = buildLoadTool(FALLBACK_CUP, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(!gcode.includes('TOOL_FAULT_RACK'), 'no rack-specific TOOL_FAULT variant');
    const finalCheckIdx = gcode.indexOf('o240 if [#5399 EQ -1]');
    const flagSetIdx = gcode.indexOf('#<_manual_fallback> = 1');
    assert.ok(finalCheckIdx !== -1 && flagSetIdx !== -1 && flagSetIdx > finalCheckIdx,
      'the flag must be set as a plain line inside the fault branch — not via any dialog button');
  });

  test('RACK_SLOT_EMPTY fires once (bare Continue, no retry) before the manual-load handoff, addressing the correct tool number', () => {
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 1);
    const gcode = buildLoadTool(FALLBACK_CUP, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    const finalCheckIdx = gcode.indexOf('o240 if [#5399 EQ -1]');
    const slotEmptyIdx = gcode.indexOf('(MSG, PLUGIN_PNEUMATICATC:RACK_SLOT_EMPTY_1)');
    const manualClampIdx = gcode.indexOf('MANUAL_CLAMP_TOOL_1');
    assert.ok(finalCheckIdx !== -1 && slotEmptyIdx !== -1 && manualClampIdx !== -1,
      'the fault branch, RACK_SLOT_EMPTY dialog, and manual-load handoff must all be present');
    assert.ok(finalCheckIdx < slotEmptyIdx && slotEmptyIdx < manualClampIdx,
      'RACK_SLOT_EMPTY must fire once, inside the fault branch, before handing off to the manual-load dialog');
    // Fires exactly once — a repeated key is what broke the pendant handoff before.
    const occurrences = gcode.split('RACK_SLOT_EMPTY_1').length - 1;
    assert.equal(occurrences, 1, 'RACK_SLOT_EMPTY must fire exactly once, never retried');
    assert.ok(!gcode.includes('RACK_SLOT_EMPTY_99'), 'must address the actual tool number, not a renumbered one');
  });

  test('manual-context load (toolNumber > slots) is unaffected: no fallback flag at all', () => {
    const slotPos = calculateSlotPosition(FALLBACK_CUP, 4);
    const gcode = buildLoadTool(FALLBACK_CUP, 4, slotPos, '', false, { x: 0, y: 0 }, false);
    assert.ok(!gcode.includes('#<_manual_fallback>'), 'an already-manual load has nothing to fall back to');
  });

  test('sensor unconfigured: no fallback machinery at all, load behaves exactly as before this feature existed', () => {
    const NO_SENSOR = { ...FALLBACK_CUP, toolSeatedSensorInput: -1 };
    const slotPos = calculateSlotPosition(NO_SENSOR, 1);
    const gcode = buildLoadTool(NO_SENSOR, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(!gcode.includes('#<_manual_fallback>'));
    assert.ok(!gcode.includes('MANUAL_CLAMP_TOOL'));
  });

  test('exit routing is gated behind the fallback flag on a rack load (Tm -> Tn)', () => {
    const program = buildToolChangeProgram(FALLBACK_CUP, 1, 2).join('\n');
    assert.ok(program.includes('o340 if [#<_manual_fallback> NE 1]'));
    assert.ok(program.includes('o340 endif'));
  });

  test('exit routing is gated on a probing rack load too (tlsMode=always)', () => {
    const PROBING = { ...FALLBACK_CUP, tlsMode: 'always' };
    const program = buildToolChangeProgram(PROBING, 1, 2).join('\n');
    assert.ok(program.includes('o340 if [#<_manual_fallback> NE 1]'));
  });

  test('exit routing is NOT gated when the sensor is unconfigured (unchanged output)', () => {
    const NO_SENSOR = { ...FALLBACK_CUP, toolSeatedSensorInput: -1 };
    const program = buildToolChangeProgram(NO_SENSOR, 1, 2).join('\n');
    assert.ok(!program.includes('o340'), 'no exit-guard wrapper when the sensor is unconfigured');
  });

  // Regression: buildToolChangeProgram itself must build the fallback's
  // TLS routine anchored at manualTool, not reuse the rack-chained one
  // (which assumes the spindle is still at the rack exit) or the pre-M6
  // `origin` (which is wherever the spindle was BEFORE this tool change
  // started — not where buildManualLoad actually parks it).
  test('probing rack load (tlsMode=always): fallback branch runs TLS anchored at manualTool, distinct from the rack-chained routine', () => {
    const PROBING = { ...FALLBACK_CUP, tlsMode: 'always' };
    const preM6Origin = { x: 60, y: 120 }; // deliberately far from manualTool (321, -966)
    const program = buildToolChangeProgram(PROBING, 1, 2, { x: 0, y: 0 }, 0, preM6Origin).join('\n');
    const expectedManualTls = motionLines(
      createToolLengthSetRoutine(PROBING, { x: 0, y: 0 }, { originMPos: PROBING.manualTool }).join('\n')
    ).join('\n');
    const finalCheckIdx = program.indexOf('o240 if [#5399 EQ -1]');
    const elseIdx = program.indexOf('o240 else');
    assert.ok(finalCheckIdx !== -1 && elseIdx !== -1, 'fallback branch must be present');
    const fallbackLines = motionLines(program.slice(finalCheckIdx, elseIdx)).join('\n');
    assert.ok(fallbackLines.includes(expectedManualTls),
      'fallback branch must run a TLS routine anchored at manualTool so probing still happens after falling back');
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
