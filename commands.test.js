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
    const KIOSK = {
      slots: 12,
      orientation: 'Y',
      direction: 'Positive',
      slot1: { x: 3.8, y: -863.231 },
      slotDistance: 60,
      slideDirection: 'Positive',
      slideDistance: 40,
      keepoutPadding: 60,
    };
    // Keepout Y: [-923.231, -143.231]. TLS Y=-97.5 is 45.7 mm above parMax;
    // origin Y=-622.103 is 301 mm below parMax and 301 mm above parMin.
    // Origin-only rule → parMin (301 vs 479). Total-travel rule → parMax
    // (46+479=525 vs 826+301=1127).
    const gcode = tlsExit(2, -97.5, { x: 701.456, y: -622.103 }, KIOSK);
    const lines = motionLines(gcode);
    // Must route via parMax (Y=-143.231), NOT parMin (Y=-923.231).
    assert.ok(!lines.some(l => /Y-923\.231(?:\D|$)/.test(l)),
      `must NOT walk to parMin corner (Y=-923.231) — got ${JSON.stringify(lines)}`);
    assert.ok(lines.some(l => /Y-143\.231(?:\D|$)/.test(l)),
      `must route via parMax corner (Y=-143.231) — got ${JSON.stringify(lines)}`);
    // Both endpoints on opposite side of sliding edge (+X of keepout at
    // X=63.8), so both walk out to the same +X edge at parMax before
    // diagonaling to origin.
    assert.deepEqual(lines, [
      'G53 G0 X63.8 Y-143.231',       // TLS → +X edge at parMax corner
      'G53 G0 X63.8 Y-143.231',       // same corner (same-side collapse)
      'G53 G0 X701.456 Y-622.103',    // diagonal to origin
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

  test('offset=0 in both directions: no G1 compensation moves at all', () => {
    const NO_OFFSET = { ...CUP_RACK, drawbarOffset: 0 };
    const slotPos = calculateSlotPosition(NO_OFFSET, 1);
    const loadGcode = buildLoadTool(NO_OFFSET, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    const unloadGcode = buildUnloadTool(NO_OFFSET, 1, slotPos, { x: 60, y: 120 });
    // No G1 Z moves emitted for load or unload — the compensation is skipped.
    assert.ok(!motionLines(loadGcode).some(l => /^G53 G1 Z/.test(l)),
      'load with offset=0 must NOT emit a G1 Z seat move');
    assert.ok(!motionLines(unloadGcode).some(l => /^G53 G1 Z/.test(l)),
      'unload with offset=0 must NOT emit a G1 Z back-off move');
  });

  test('drawbarOffset reaches emitted G-code (non-default value proof, both directions)', () => {
    const NON_DEFAULT = { ...CUP_RACK, drawbarOffset: 1.5 };
    const slotPos = calculateSlotPosition(NON_DEFAULT, 1);
    // Load-side: approach at slot.z + 1.5 = -98.5, seat back at slot.z.
    const loadGcode = buildLoadTool(NON_DEFAULT, 1, slotPos, '', false, { x: 60, y: 120 }, false);
    assert.ok(motionLines(loadGcode).some(l => l === 'G53 G0 Z-98.5'),
      'load approach must use slot.z + drawbarOffset = -98.5');
    assert.ok(motionLines(loadGcode).some(l => l === 'G53 G1 Z-100 F300'),
      'load seat must G1 to slot.z at drawbarFeedrate');
    // Unload-side: descend to slot.z, G1 back off to slot.z + 1.5 = -98.5.
    const unloadGcode = buildUnloadTool(NON_DEFAULT, 1, slotPos, { x: 60, y: 120 });
    assert.ok(motionLines(unloadGcode).some(l => l === 'G53 G1 Z-98.5 F300'),
      'unload back-off must use slot.z + drawbarOffset = -98.5 at drawbarFeedrate');
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
