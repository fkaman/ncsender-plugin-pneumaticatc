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
  tlsEntrance,
  tlsExit,
  buildLoadTool,
  buildUnloadTool,
  calculateSlotPosition,
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
