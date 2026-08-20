/**
 * Pneumatic ATC - Command Processor
 * Pure command processing logic for pneumatic automatic tool changer support.
 * Runs on Node.js natively OR on .NET via Jint.
 * No import/require/fetch/ctx — pure input→output.
 *
 * Copyright (C) 2024 Francis Marasigan
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const ORIENTATIONS = ['X', 'Y'];
const DIRECTIONS = ['Positive', 'Negative'];
const LAYOUT_MODES = ['linear', 'custom'];
// TLS strategies:
//   'library' — reuse the tool library TLO; probe automatically when the
//               tool's TLO is missing (== 0), so the first swap of a fresh
//               tool primes the value.
//   'always'  — probe on every M6 regardless of what's in the library.
// Legacy 'first' → migrated to 'library' (same net behavior).
const TLS_MODES = ['library', 'always'];
const MAX_SLOTS = 32;

// Pneumatic drawbar compensation for CUP-style racks only. On a cup rack
// the tool holder rests on the cup lip and the drawbar's actuation would
// otherwise push the holder up out of / down into the taper. A tiny
// (1 mm) G1 in the opposite direction at a slow feed (matches the
// solenoid's ~200 ms actuation time) neutralises that motion so the
// holder stays on the cup lip throughout. Fork racks slide horizontally
// into/out of engagement and don't need this — omitted below.
const DRAWBAR_OFFSET_MM = 1;
const DRAWBAR_FEEDRATE_MMPM = 300;

const M6_PATTERN = /(?:^|[^A-Z])M0*6(?:\s*T0*(\d+)|(?=[^0-9T])|$)|(?:^|[^A-Z])T0*(\d+)\s*M0*6(?:[^0-9]|$)/i;
const SLOT_PATTERN = /^\$SLOT0*(\d+)$/i;

function isGcodeComment(command) {
  const trimmed = command.trim();
  const withoutLineNumber = trimmed.replace(/^N\d+\s*/i, '');
  if (withoutLineNumber.startsWith(';')) return true;
  if (withoutLineNumber.startsWith('(') && withoutLineNumber.endsWith(')')) return true;
  return false;
}

function parseM6Command(command) {
  if (!command || typeof command !== 'string') return null;
  if (isGcodeComment(command)) return null;
  const normalized = command.trim().toUpperCase();
  const match = normalized.match(M6_PATTERN);
  if (!match) return null;
  const toolStr = match[1] || match[2];
  const tool = toolStr ? parseInt(toolStr, 10) : null;
  return { toolNumber: Number.isFinite(tool) ? tool : null, matched: true };
}

function parseSlotCommand(command) {
  if (!command || typeof command !== 'string') return null;
  const m = command.trim().toUpperCase().match(SLOT_PATTERN);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// === Sanitization helpers ===

const clampSlots = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(Math.max(parsed, 1), MAX_SLOTS);
};

const toFiniteNumber = (value, fallback = 0) => {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
};

const sanitizeOrientation = (value) => (ORIENTATIONS.includes(value) ? value : 'Y');
const sanitizeDirection = (value) => (DIRECTIONS.includes(value) ? value : 'Negative');
const sanitizeSlideDirection = (value) => (value === 'Positive' ? 'Positive' : 'Negative');
const sanitizeLayoutMode = (value) => (LAYOUT_MODES.includes(value) ? value : 'linear');
const sanitizeTlsMode = (value, legacyPerformTlsOnChange) => {
  if (value === 'first') return 'library';        // legacy 3-way → 2-way
  if (TLS_MODES.includes(value)) return value;
  // Legacy setting explicitly disabled probing → keep library. Otherwise
  // default to 'always' (safest for first-time setups where the library
  // TLO isn't populated yet).
  return legacyPerformTlsOnChange === false ? 'library' : 'always';
};

const sanitizeCoords2D = (coords = {}) => ({
  x: toFiniteNumber(coords.x),
  y: toFiniteNumber(coords.y)
});
const sanitizeCoords3D = (coords = {}) => ({
  x: toFiniteNumber(coords.x),
  y: toFiniteNumber(coords.y),
  z: toFiniteNumber(coords.z)
});

const sanitizeAuxOutput = (value) => {
  if (value === 'M7' || value === 'M8') return value;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
};

// Aux INPUT port number for a sensor. -1 means "not wired" and every check
// that depends on it is skipped — M66 against a port the board doesn't have
// is not an error the operator can act on, it just leaves #5399 stale.
const sanitizeAuxInput = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
};

// Custom-mode per-slot XY. Returns a Map keyed by slot number for O(1) lookup.
function sanitizeSlotCoords(raw, slots) {
  const map = new Map();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const n = Number.parseInt(entry.n, 10);
    if (!Number.isFinite(n) || n < 1 || n > slots) continue;
    map.set(n, { x: toFiniteNumber(entry.x), y: toFiniteNumber(entry.y) });
  }
  return map;
}

// Translate a legacy `tlsAuxOutput` value to the equivalent gcode line
// that the removed built-in Pre/Post TLS aux toggling used to emit.
// Returns '' when there's nothing to migrate so a truly-empty new
// install ends up with empty Pre/Post TLS fields.
function migrateLegacyTlsAux(auxOutput, action) {
  if (auxOutput === undefined || auxOutput === null || auxOutput === -1) return '';
  const { on, off } = auxOnOff(auxOutput);
  const cmd = action === 'on' ? on : off;
  return cmd ? `G4 P0\n${cmd}\nG4 P0` : '';
}

const buildInitialConfig = (raw = {}) => {
  const slots = clampSlots(raw.slots ?? raw.pockets);
  // Slot 1 coords — accept new (`slot1`) or legacy (`pocket1`) keys, and the
  // separately-stored Z (`slot1Z` / `pocket1Z`) that older configs used.
  const slot1Raw = raw.slot1 || raw.pocket1 || {};
  const slot1Z = raw.slot1Z ?? raw.pocket1Z ?? slot1Raw.z ?? -100;

  return {
    slots,
    layoutMode: sanitizeLayoutMode(raw.layoutMode),
    orientation: sanitizeOrientation(raw.orientation),
    direction: sanitizeDirection(raw.direction),
    slideDirection: sanitizeSlideDirection(raw.slideDirection),
    slideDistance: toFiniteNumber(raw.slideDistance, 40),
    slideSpeed: toFiniteNumber(raw.slideSpeed, 500),
    // Slot Distance default bumped to 60 — 45 is too tight for the 80 mm
    // spindles common on ATC-equipped machines (tools would collide).
    slotDistance: toFiniteNumber(raw.slotDistance ?? raw.pocketDistance, 60),
    // Padding used ONLY for the auto-published keepout rectangle on Pro.
    // Separate from slideDistance (which is the physical slide-off travel
    // used by rack routing) because the keepout usually wants a larger
    // safety margin around the rack than the routing itself needs.
    keepoutPadding: toFiniteNumber(raw.keepoutPadding, 60),
    rackHolding: raw.rackHolding === 'Cup' ? 'Cup' : 'Fork',

    showMacroCommand: raw.showMacroCommand ?? false,
    performTlsAfterHome: raw.performTlsAfterHome ?? false,
    tlsMode: sanitizeTlsMode(raw.tlsMode, raw.performTlsOnToolChange),

    slot1: { x: toFiniteNumber(slot1Raw.x), y: toFiniteNumber(slot1Raw.y), z: toFiniteNumber(slot1Z, -100) },
    slot1Z: toFiniteNumber(slot1Z, -100),
    slotCoords: raw.slotCoords || [],
    toolsetter: sanitizeCoords2D(raw.toolsetter ?? raw.toolSetter),
    manualTool: sanitizeCoords2D(raw.manualTool),

    zSafe: toFiniteNumber(raw.zSafe, 0),

    tlsSeekStartZ: toFiniteNumber(raw.tlsSeekStartZ, toFiniteNumber(raw.zSafe, -5)),
    seekDistance: toFiniteNumber(raw.seekDistance, 50),
    seekFeedrate: toFiniteNumber(raw.seekFeedrate, 500),

    preToolChangeGcode: raw.preToolChangeGcode ?? '',
    postToolChangeGcode: raw.postToolChangeGcode ?? '',
    abortEventGcode: raw.abortEventGcode ?? '',

    // Pre/Post TLS run right around the G38.2 probe. Backward-compat:
    // if legacy `tlsAuxOutput` is set but the new gcode fields are
    // empty, translate the old aux ON/OFF into equivalent gcode so an
    // existing user's toolsetter keeps working after the setting is
    // dropped.
    preTlsGcode: raw.preTlsGcode ?? migrateLegacyTlsAux(raw.tlsAuxOutput, 'on'),
    postTlsGcode: raw.postTlsGcode ?? migrateLegacyTlsAux(raw.tlsAuxOutput, 'off'),
    clampAuxOutput: sanitizeAuxOutput(raw.clampAuxOutput),
    // grblHAL aux INPUT carrying the air-pressure switch. -1 = no sensor
    // wired, which disables every pressure check.
    pressureInput: sanitizeAuxInput(raw.pressureInput),

    dialogBehavior: {
      countdownSec: toFiniteNumber(raw.dialogBehavior?.countdownSec, 5),
      chainSteps: !!raw.dialogBehavior?.chainSteps
    }
  };
};

// === Tool offset lookup ===
//
// Two fields to keep straight (mapped from ncSender's ToolOffsets):
//   * `tool.offsets.z`     — the stored Tool Length Offset (Tlo) from the
//                             library. Used by the 'library' TLS strategy
//                             to decide whether we already have a value.
//   * `tool.offsets.tlsZ`  — per-tool custom Z bias applied *during* the
//                             TLS probe motion (e.g. for oddball fixtures).
//                             Separate from TLO.

function getToolProbeOffsets(toolNumber, tools) {
  if (!toolNumber || toolNumber <= 0 || !Array.isArray(tools)) {
    return { x: 0, y: 0, z: 0 };
  }
  const tool = tools.find((t) => t.toolNumber === toolNumber);
  if (tool && tool.offsets) {
    return { x: tool.offsets.x || 0, y: tool.offsets.y || 0, z: tool.offsets.tlsZ || 0 };
  }
  return { x: 0, y: 0, z: 0 };
}

function getStoredTlo(toolNumber, tools) {
  if (!toolNumber || toolNumber <= 0 || !Array.isArray(tools)) return 0;
  const tool = tools.find((t) => t.toolNumber === toolNumber);
  if (!tool || !tool.offsets) return 0;
  return tool.offsets.z || 0;
}

// Back-compat alias for older call sites within this file.
const getToolOffsets = getToolProbeOffsets;

// === G-code helpers ===

function formatGCode(gcode) {
  const lines = gcode.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const formatted = [];
  let indentLevel = 0;

  for (const line of lines) {
    const upperLine = line.toUpperCase();
    const isOCode = upperLine.startsWith('O');
    if (isOCode && (
      upperLine.includes('ENDIF') || upperLine.includes('ENDWHILE') ||
      upperLine.includes('ENDREPEAT') || upperLine.includes('ENDSUB') || upperLine.includes('ELSE')
    )) {
      indentLevel = Math.max(0, indentLevel - 1);
    }
    const indent = '  '.repeat(indentLevel);
    // Pro core only: prefix G53 machine-coord motion with `$keepout_off`
    // so the ATC's rack routing (which is by design inside the keepout
    // zone) isn't blocked by the core's keepout enforcement. Per-line
    // prefix instead of a modal start/end pair means an aborted swap
    // can't leave the check permanently disabled. G53 is used ONLY for
    // trusted rack routing in this plugin, so scoping the bypass to
    // G53-tagged lines is both sufficient and audit-friendly.
    // Community core doesn't ship the keepout enforcement or the prefix
    // parser, so the token would just get logged as an unknown command
    // — we omit it there.
    const isMachineMove = /(^|[^A-Z])G0*53(?:[^0-9]|$)/i.test(line);
    const prefixed = (isMachineMove && _coreEdition === 'pro')
      ? `$keepout_off ${line}`
      : line;
    formatted.push(indent + prefixed);
    if (isOCode && (
      upperLine.includes(' IF ') || upperLine.includes(' WHILE ') ||
      upperLine.includes(' DO ') || upperLine.includes('REPEAT') || upperLine.includes(' SUB')
    )) {
      indentLevel += 1;
    }
    if (isOCode && upperLine.includes('ELSE') && !upperLine.includes('ELSEIF')) {
      indentLevel += 1;
    }
  }
  return formatted;
}

// Reindent a multi-line user gcode block so it slots cleanly into the
// TLS template literal. Empty / whitespace-only input yields '' so the
// surrounding template doesn't leave a blank line in the composed
// macro.
function indentBlock(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  return lines.join('\n    ');
}

function auxOnOff(auxOutput) {
  if (auxOutput === 'M7' || auxOutput === 'M8') return { on: auxOutput, off: 'M9' };
  if (typeof auxOutput === 'number' && auxOutput >= 0) {
    return { on: `M64 P${auxOutput}`, off: `M65 P${auxOutput}` };
  }
  return { on: '', off: '' };
}

// === Tool Length Setter routine ===

function createToolLengthSetRoutine(settings, toolOffsets = { x: 0, y: 0, z: 0 }, options = {}) {
  const tlsX = settings.toolsetter.x + (toolOffsets.x || 0);
  const tlsY = settings.toolsetter.y + (toolOffsets.y || 0);
  // TLS approach uses routePoint to avoid cutting through the rack
  // keepout. When origin is known, edge selection follows the Cup/Fork
  // rules encoded in pickEntryEdge (Cup → origin-side; Fork → sliding
  // side always). When origin is unknown (older host), fall back to a
  // 2-move approach through pickEntryEdge's default edge if TLS sits
  // inside the perp band; a single direct move if outside.
  //
  // options.skipXYApproach — when the caller already parked the spindle
  // at (tlsX, tlsY) (e.g. rackExitToTLS ran immediately before this
  // routine), don't re-emit the edge-hop + perp-in — those moves would
  // walk out to the edge and back for no reason.
  const originMPos = options.originMPos;
  const tlsTarget = { x: tlsX, y: tlsY };
  const approachWaypoints = options.skipXYApproach
    ? []
    : (originMPos
        ? routePoint(originMPos, tlsTarget, settings, { edgeAnchor: originMPos })
        : approachWithoutOrigin(tlsTarget, settings));
  const tlsApproach = approachWaypoints
    .map((p) => `G53 G0 X${p.x} Y${p.y}`)
    .join('\n    ');
  // Per-tool TLS bias from the tool library — added on top of the
  // configured start Z. Long tools store a positive bias so probing
  // starts higher up (further from the toolsetter) to avoid crashing.
  const tlsLibZ = toolOffsets.z || 0;
  // Absolute machine Z where the seek begins. Defaults to safe Z so
  // the seek starts from the current retract height (previous
  // behavior). Setting a value closer to the toolsetter dramatically
  // shortens the seek travel on tall Z gantries.
  const seekStartZ = (typeof settings.tlsSeekStartZ === 'number'
    ? settings.tlsSeekStartZ
    : settings.zSafe) + tlsLibZ;

  // User-provided gcode fired around the probe cycle. Trimmed +
  // re-indented to keep the composed macro readable.
  const preTls = indentBlock(settings.preTlsGcode);
  const postTls = indentBlock(settings.postTlsGcode);

  // Distance to descend from safe Z down to the seek start position.
  // Positive when seekStartZ is above safeZ (skip the approach in that
  // case — nothing to descend to).
  const approachDelta = seekStartZ - settings.zSafe;
  // Safety descent: instead of G0 rapiding blind to the seek start Z,
  // use G38.3 as a "probe toward" — same fast motion (grblHAL clamps
  // F99999 to the machine Z max rate $112), but if the tool contacts
  // the toolsetter early (mis-configured Seek Start Z, tool longer
  // than expected, etc.) the machine HALTS at contact instead of
  // crashing. The follow-up G38.2 seek will then error with "probe
  // already triggered", surfacing the problem to the operator.
  const approach = approachDelta < 0
    ? `G38.3 G91 Z${approachDelta.toFixed(3)} F99999\n    G90`
    : '';

  const gcode = `
    G53 G0 Z${settings.zSafe}
    ${tlsApproach}
    (Select toolsetter probe input for the measurement below)
    G65 P5 Q1
    ${approach}
    ${preTls}
    G43.1 Z0
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G4 P0.2
    G38.4 G91 Z5 F25
    (Slow 1mm ease-off before rapid retract — strong TLS springs bounce if released too fast)
    G91 G1 Z1 F25
    G91 G0 Z5
    G90
    (Restore primary probe input)
    G65 P5 Q0
    ${postTls}
    #<_ofs_idx> = [#5220 * 20 + 5203]
    #<_cur_wcs_z_ofs> = #[#<_ofs_idx>]
    #<_nc_last_tlo> = [#5063 + #<_cur_wcs_z_ofs>]
    G43.1 Z[#<_nc_last_tlo>]
    (Notify ncSender that toolLengthSet is now set)
    $#=_tool_offset
    (Trigger a full [#] dump so ncSender receives [TLO:xxx] for writeback)
    $#
  `.trim();
  return gcode.split('\n');
}

// Fallback 2-move approach when originMPos is not supplied. Picks the
// edge via pickEntryEdge with an undefined anchor (Cup → workspace side,
// Fork → sliding side) and emits (edge, clampedTlsPar) → TLS if TLS
// sits inside the padded perp band; single direct move if outside.
function approachWithoutOrigin(tlsTarget, settings) {
  const orientationY = settings.orientation === 'Y';
  const pad = settings.keepoutPadding ?? settings.slideDistance ?? 0;
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  const slot1Par  = orientationY ? settings.slot1.y : settings.slot1.x;
  const slotNPar  = slotParFor(settings.slots, settings);
  const parMin = Math.min(slot1Par, slotNPar) - pad;
  const parMax = Math.max(slot1Par, slotNPar) + pad;
  const tlsPerp = orientationY ? tlsTarget.x : tlsTarget.y;
  const tlsPar  = orientationY ? tlsTarget.y : tlsTarget.x;
  const tlsInsidePerpRange = tlsPerp > slot1Perp - pad && tlsPerp < slot1Perp + pad;
  if (!tlsInsidePerpRange) return [tlsTarget];
  const entryPerp = pickEntryEdge(settings, undefined);
  const clampedPar = Math.max(parMin, Math.min(parMax, tlsPar));
  const edgePoint = orientationY
    ? { x: entryPerp, y: clampedPar }
    : { x: clampedPar, y: entryPerp };
  return [edgePoint, tlsTarget];
}

// Exit move for post-TLS Z-safe: mirror of the approach.
// Uses routePoint(TLS → origin) with the same edgeAnchor rules so the
// approach and exit converge on the same edge. Returns '' when TLS
// sits outside the perp range (direct move is safe).
//
// The full waypoints INCLUDING the final leg back to origin are
// emitted here. Callers already at origin (nothing more to do) or
// that explicitly return to (0,0) after homing tolerate the redundant
// final move.
//
// When originMPos is missing (older host), fall back to a single
// edge-hop that just gets the tool out of the padded perp band —
// operator continues from there.
function createToolLengthSetExitMove(settings, toolOffsets = { x: 0, y: 0, z: 0 }, options = {}) {
  const tlsX = settings.toolsetter.x + (toolOffsets.x || 0);
  const tlsY = settings.toolsetter.y + (toolOffsets.y || 0);
  const originMPos = options.originMPos;

  // Always run routePoint(TLS -> origin) when we know the origin, and let
  // it decide whether a detour is needed. The old TLS-inside-perp-band
  // short-circuit was too narrow — even when TLS sits outside the perp
  // band, a direct TLS -> origin diagonal can still cut through the
  // keepout if origin is on the far side. routePoint returns just [origin]
  // when the direct move is clean, so we emit a single move (which the
  // client's return-to-origin move would have done anyway) or 2-3 lines
  // for a detour.
  //
  // If origin is unknown (older host), fall back to the edge-only hop
  // that peels TLS off the rack so the client's follow-up move starts
  // from a safe perimeter point.
  const tlsTarget = { x: tlsX, y: tlsY };
  const waypoints = originMPos
    ? routePoint(tlsTarget, originMPos, settings, { edgeAnchor: originMPos })
    : approachWithoutOrigin(tlsTarget, settings).slice(0, -1); // just the edge hop
  if (waypoints.length === 0) return '';
  return waypoints.map((p) => `G53 G0 X${p.x} Y${p.y}`).join('\n    ');
}

function createToolLengthSetProgram(settings, toolOffsets = { x: 0, y: 0, z: 0 }, options = {}) {
  const tlsRoutine = createToolLengthSetRoutine(settings, toolOffsets, options).join('\n');
  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';
  const tlsExitMove = createToolLengthSetExitMove(settings, toolOffsets, options);

  const gcode = `
    (Start of Tool Length Setter)
    ${preCmd}
    #<return_units> = [20 + #<_metric>]
    G21
    ${tlsRoutine}
    G53 G0 Z${settings.zSafe}
    ${tlsExitMove}
    G4 P0
    G[#<return_units>]
    ${postCmd}
    (End of Tool Length Setter)
  `.trim();
  return formatGCode(gcode);
}

// === Slot position calculation ===
//
// Two modes:
//   linear: Slot 1 X/Y + slotDistance + orientation/direction generate the row.
//   custom: per-slot XY comes from settings.slotCoords; falls back to Slot 1
//           if a specific slot is missing.
// The `approach` position is `slideDistance` away from the engaged position
// along the axis perpendicular to Orientation — that's where the spindle
// starts before sliding into the fork.

function calculateSlotBase(settings, slotNum) {
  if (slotNum <= 0) return { x: settings.slot1.x, y: settings.slot1.y };

  if (settings.layoutMode === 'custom') {
    const map = sanitizeSlotCoords(settings.slotCoords, settings.slots);
    const hit = map.get(slotNum);
    if (hit) return hit;
    // Fallback so a missing custom row doesn't produce NaN math.
    return { x: settings.slot1.x, y: settings.slot1.y };
  }

  const dir = settings.direction === 'Negative' ? -1 : 1;
  const offset = (slotNum - 1) * settings.slotDistance * dir;
  return settings.orientation === 'Y'
    ? { x: settings.slot1.x, y: settings.slot1.y + offset }
    : { x: settings.slot1.x + offset, y: settings.slot1.y };
}

function calculateSlotPosition(settings, slotNum) {
  const base = calculateSlotBase(settings, slotNum);
  const slideSign = settings.slideDirection === 'Positive' ? 1 : -1;
  // Approach sits opposite the slide direction.
  const approachOffset = -slideSign * (settings.slideDistance || 0);
  const approach = settings.orientation === 'Y'
    ? { x: base.x + approachOffset, y: base.y }
    : { x: base.x, y: base.y + approachOffset };
  return { engaged: base, approach };
}

// === Rack keepout zone + slot geometry ================================
//
// Everything below is derived from four numbers:
//   * slot1 XY, slotDistance, slots count → slot centers along the par axis
//   * keepoutPadding → outer keepout rectangle
//   * slideDistance  → slot approach point (physical slide start)
//
// Sliding side = the side of the rack the operator's workspace lives on
// (opposite of slideDirection — slideDirection is where the tool SLIDES
// when engaging). Every rack entry / exit lands on the sliding-side
// edge of the outer keepout rectangle before descending into the box
// to the slot approach point.

// Slot par coord for slot N (1-indexed). Par is the axis slots stack
// along (Y for orientation='Y', X for orientation='X').
function slotParFor(slotNumber, settings) {
  const dirSign = settings.direction === 'Positive' ? 1 : -1;
  const orientationY = settings.orientation === 'Y';
  const slot1Par = orientationY ? settings.slot1.y : settings.slot1.x;
  return slot1Par + (slotNumber - 1) * settings.slotDistance * dirSign;
}

// XY of slot N's engaged position (where the tool sits in the rack).
function slotEngagedXY(slotNumber, settings) {
  const par = slotParFor(slotNumber, settings);
  return settings.orientation === 'Y'
    ? { x: settings.slot1.x, y: par }
    : { x: par,                y: settings.slot1.y };
}

// The outer keepout rectangle in machine coords. Padded by keepoutPadding
// on all four sides around the slot1..slotN axis, matching the rectangle
// the visualizer draws.
function computeKeepoutZone(settings) {
  const pad = settings.keepoutPadding ?? settings.slideDistance ?? 0;
  const orientationY = settings.orientation === 'Y';
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  const slot1Par  = orientationY ? settings.slot1.y : settings.slot1.x;
  const slotNPar  = slotParFor(settings.slots, settings);
  const parMin = Math.min(slot1Par, slotNPar) - pad;
  const parMax = Math.max(slot1Par, slotNPar) + pad;
  const perpMin = slot1Perp - pad;
  const perpMax = slot1Perp + pad;
  return {
    minX: orientationY ? perpMin : parMin,
    maxX: orientationY ? perpMax : parMax,
    minY: orientationY ? parMin  : perpMin,
    maxY: orientationY ? parMax  : perpMax,
  };
}

// Line-segment vs axis-aligned rectangle intersection (slab method).
// Returns true if the segment (ax,ay)→(bx,by) touches or crosses the
// rectangle [minX,maxX] × [minY,maxY]. Used by tlsExit to decide
// between a direct diagonal (safe) and a corner detour (crosses the
// padded keepout box). Cheap enough to call per-routing decision.
function segmentIntersectsRect(ax, ay, bx, by, minX, maxX, minY, maxY) {
  const inside = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  if (inside(ax, ay) || inside(bx, by)) return true;
  const dx = bx - ax;
  const dy = by - ay;
  let tMin = 0, tMax = 1;
  if (dx === 0) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const t1 = (minX - ax) / dx;
    const t2 = (maxX - ax) / dx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  if (dy === 0) {
    if (ay < minY || ay > maxY) return false;
  } else {
    const t1 = (minY - ay) / dy;
    const t2 = (maxY - ay) / dy;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  return true;
}

// Sliding-side padded perp — the perp coord on the OUTER edge of the
// keepout zone, on the side the tool approaches from. `slotEntryPoint`
// sits on this line; every rack entry / exit lands here first.
function slidingSidePerp(settings) {
  const pad = settings.keepoutPadding ?? settings.slideDistance ?? 0;
  const slideSign = settings.slideDirection === 'Positive' ? 1 : -1;
  const approachSign = -slideSign;
  const orientationY = settings.orientation === 'Y';
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  return slot1Perp + approachSign * pad;
}

// Slot approach perp — inside the keepout box, `slideDistance` from the
// rack line on the sliding side. This is where the G1 slide-in starts.
// A single perp move bridges from slotEntryPoint (outer edge) down to
// this coord; it's inside the keepout so `$keepout_off` (auto-prefixed
// by formatGCode on G53 lines) is what lets it through.
function slotApproachPerp(settings) {
  const slideSign = settings.slideDirection === 'Positive' ? 1 : -1;
  const approachSign = -slideSign;
  const orientationY = settings.orientation === 'Y';
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  return slot1Perp + approachSign * (settings.slideDistance || 0);
}

// Entry point for a slot: on the outer keepout edge (sliding side),
// aligned with the slot's par column. Routing to a slot ends here;
// routing away from a slot starts here.
function slotEntryPoint(slotNumber, settings) {
  const par = slotParFor(slotNumber, settings);
  const perp = slidingSidePerp(settings);
  return settings.orientation === 'Y'
    ? { x: perp, y: par }
    : { x: par,  y: perp };
}

// Approach point for a slot: inside the keepout, `slideDistance` from
// the slot on the sliding side. G1 slide-in runs from here to engaged.
function slotApproachPoint(slotNumber, settings) {
  const par = slotParFor(slotNumber, settings);
  const perp = slotApproachPerp(settings);
  return settings.orientation === 'Y'
    ? { x: perp, y: par }
    : { x: par,  y: perp };
}

// === Routing ==========================================================
//
// One primitive — `routePoint(from, to, settings, options)` — powers
// every rack / cup / TLS entry and exit. Returns the list of XY
// waypoints between `from` (exclusive) and `to` (inclusive) that avoid
// cutting through occupied slot columns.
//
// TODO: `machineTravel` soft-limit filtering isn't plumbed yet — plugin
// doesn't get soft-limit bounds from the host. When it does, filter
// waypoints against `{xMin, xMax, yMin, yMax}` and try the OTHER perp
// edge (for Cup) if the picked one lands outside travel.

// Pick the perp edge that a detour route through the keepout should use.
//
// Fork: sliding-side always — the fork tang can only engage from that
//       side, so every fork-touching path uses the same edge to keep
//       downstream slot-entry moves consistent.
// Cup:  origin/destination-side edge when the anchor is past a perp
//       edge (shortest hop); workspace-side edge otherwise (matches
//       cupEntrance's degenerate branch — inside-band anchor).
function pickEntryEdge(settings, edgeAnchor) {
  const orientationY = settings.orientation === 'Y';
  const pad = settings.keepoutPadding ?? settings.slideDistance ?? 0;
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  const perpMin = slot1Perp - pad;
  const perpMax = slot1Perp + pad;

  if (settings.rackHolding === 'Cup') {
    if (edgeAnchor) {
      const anchorPerp = orientationY ? edgeAnchor.x : edgeAnchor.y;
      if (anchorPerp >= perpMax) return perpMax;
      if (anchorPerp <= perpMin) return perpMin;
    }
    const slideSign = settings.slideDirection === 'Positive' ? 1 : -1;
    return slot1Perp + slideSign * pad;
  }

  return slidingSidePerp(settings);
}

// Route from `from` to `to` avoiding the padded keepout box.
//
// options.edgeAnchor — point that anchors edge picking for Cup (default:
//   `from`). Pass the destination for exit routes so the picked edge
//   matches where the tool ends up.
// options.machineTravel — TODO (see routing section header).
//
// Returns waypoints excluding `from`, including `to`.
//
// Algorithm:
//   1. If direct segment doesn't intersect the box → single-move [to].
//   2. Otherwise route via one perp edge (pickEntryEdge). For each
//      endpoint NOT already on that edge's outside:
//        - Simple case (endpoint inside perp band, OR its par is
//          outside the par range): one corner on the entry edge at the
//          endpoint's clamped par. Diagonal endpoint → corner stays
//          past the par-end when par is outside, or perp-only within
//          the safe row when inside.
//        - Opposite case (endpoint on the OPPOSITE perp side with par
//          INSIDE the par range): two corners at a shared par-end —
//          opposite-side corner first (from → oppositeCorner stays
//          past that par-end), then perp-cross at the par-end edge
//          to the entry-side corner.
//      Corners collapse (dedup) when consecutive waypoints coincide,
//      so a same-par-end shared corner emits only once.
//
// Edge case punted for now: BOTH endpoints outside perp band on
// OPPOSITE perp sides (fork forced to slidingSide with destination on
// the other side, no rack-slot in play). Hasn't shown up as a live
// bug — direct move to `to` from the picked edge may cut the box in
// this configuration. Add machineTravel-aware handling when needed.
function routePoint(from, to, settings, options = {}) {
  const orientationY = settings.orientation === 'Y';
  const pad = settings.keepoutPadding ?? settings.slideDistance ?? 0;
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  const slot1Par  = orientationY ? settings.slot1.y : settings.slot1.x;
  const slotNPar  = slotParFor(settings.slots, settings);
  const parMin = Math.min(slot1Par, slotNPar) - pad;
  const parMax = Math.max(slot1Par, slotNPar) + pad;
  const perpMin = slot1Perp - pad;
  const perpMax = slot1Perp + pad;
  const zone = {
    minX: orientationY ? perpMin : parMin,
    maxX: orientationY ? perpMax : parMax,
    minY: orientationY ? parMin  : perpMin,
    maxY: orientationY ? parMax  : perpMax,
  };

  const toPoint = { x: to.x, y: to.y };

  if (!segmentIntersectsRect(from.x, from.y, to.x, to.y,
                             zone.minX, zone.maxX, zone.minY, zone.maxY)) {
    return [toPoint];
  }

  const edgeAnchor = options.edgeAnchor ?? from;
  const entryPerp = pickEntryEdge(settings, edgeAnchor);
  // oppositePerp = the OTHER edge of the padded perp band.
  const oppositePerp = entryPerp === perpMax ? perpMin
                     : entryPerp === perpMin ? perpMax
                     : (2 * slot1Perp - entryPerp);
  // entryDir: which way "past the entry edge" points. +1 if entryPerp
  // is the +side edge, -1 if -side. Boundary check uses strict inequality.
  const entryDir = Math.sign(entryPerp - slot1Perp) || 1;

  const getPerp = (p) => orientationY ? p.x : p.y;
  const getPar  = (p) => orientationY ? p.y : p.x;
  const makePoint = (perp, par) => orientationY ? { x: perp, y: par } : { x: par, y: perp };
  const clampPar = (p) => Math.max(parMin, Math.min(parMax, p));

  const fromPerp = getPerp(from);
  const fromPar  = getPar(from);
  const toPerp   = getPerp(to);
  const toPar    = getPar(to);

  const isOnEntrySide = (perp) => entryDir * (perp - entryPerp) >= 0;
  const isInsidePerp  = (perp) => perp > perpMin && perp < perpMax;
  const isParInside   = (par)  => par  > parMin  && par  < parMax;

  // Pick a shared par-end corner when either endpoint needs the
  // opposite-side detour — minimize total par travel (fromPar → corner
  // + corner → toPar). Matters when both endpoints share the corner;
  // harmless when only one does.
  const parViaMin = Math.abs(fromPar - parMin) + Math.abs(toPar - parMin);
  const parViaMax = Math.abs(fromPar - parMax) + Math.abs(toPar - parMax);
  const sharedCornerPar = parViaMin <= parViaMax ? parMin : parMax;

  const pushDedup = (list, point) => {
    const last = list[list.length - 1];
    if (last && last.x === point.x && last.y === point.y) return;
    list.push(point);
  };

  const waypoints = [];

  if (!isOnEntrySide(fromPerp)) {
    if (isInsidePerp(fromPerp) || !isParInside(fromPar)) {
      // Simple case: one corner at (entryPerp, clampedFromPar).
      pushDedup(waypoints, makePoint(entryPerp, clampPar(fromPar)));
    } else {
      // Opposite perp side + par inside range → 4-move opposite detour.
      pushDedup(waypoints, makePoint(oppositePerp, sharedCornerPar));
      pushDedup(waypoints, makePoint(entryPerp,    sharedCornerPar));
    }
  }

  if (!isOnEntrySide(toPerp)) {
    if (isInsidePerp(toPerp) || !isParInside(toPar)) {
      pushDedup(waypoints, makePoint(entryPerp, clampPar(toPar)));
    } else {
      pushDedup(waypoints, makePoint(entryPerp,    sharedCornerPar));
      pushDedup(waypoints, makePoint(oppositePerp, sharedCornerPar));
    }
  }

  pushDedup(waypoints, toPoint);
  return waypoints;
}

// Format routePoint waypoints as G-code lines (one per waypoint).
function waypointsToGCode(waypoints) {
  return waypoints.map((p) => `G53 G0 X${p.x} Y${p.y}`).join('\n      ');
}

// Enter a slot: routePoint to the slot's entry point (on outer edge),
// then a single perp descent from the outer edge down to the slot
// approach point. Machine ends at the slot approach, ready for the
// caller's Z descent + G1 slide-in.
function rackEntrance(targetSlotXY, origin, settings) {
  const orientationY = settings.orientation === 'Y';
  const perpAxis = orientationY ? 'X' : 'Y';
  const parAxis  = orientationY ? 'Y' : 'X';
  const targetPar = parAxis === 'X' ? targetSlotXY.x : targetSlotXY.y;
  const entryPerp = slidingSidePerp(settings);
  const approachPerp = slotApproachPerp(settings);
  const entry = perpAxis === 'X'
    ? { x: entryPerp, y: targetPar }
    : { x: targetPar, y: entryPerp };
  const waypoints = routePoint(origin, entry, settings, { edgeAnchor: origin });
  const lines = waypointsToGCode(waypoints);
  return `
    (rackEntrance: routePoint origin -> slot entry + perp descent to approach.)
    ${lines}
    G53 G0 ${perpAxis}${approachPerp}
  `.trim();
}

// Exit a slot: perp ascent from the slot approach up to the outer edge
// (the slot's entry point), then a direct diagonal to the destination.
// Used for both the return-to-origin and go-to-TLS paths; the caller
// decides which XY to pass as the destination.
function rackExit(fromSlotXY, destination, settings) {
  const orientationY = settings.orientation === 'Y';
  const perpAxis = orientationY ? 'X' : 'Y';
  const parAxis  = orientationY ? 'Y' : 'X';
  const entryPerp = slidingSidePerp(settings);
  // Slot engaged sits INSIDE the box on the slot-approach side; the
  // perp ascent bumps us to the outer sliding edge before routePoint
  // takes over. After ascent, our starting XY is (entryPerp, slot par).
  const fromPar = parAxis === 'X' ? fromSlotXY.x : fromSlotXY.y;
  const ascentStart = perpAxis === 'X'
    ? { x: entryPerp, y: fromPar }
    : { x: fromPar,   y: entryPerp };
  const waypoints = routePoint(ascentStart, destination, settings, { edgeAnchor: destination });
  const lines = waypointsToGCode(waypoints);
  return `
    (rackExit: perp ascent to sliding edge + routePoint edge -> destination.)
    G53 G0 ${perpAxis}${entryPerp}
    ${lines}
  `.trim();
}

// === Cup-specific routing ===============================================
//
// Fork must enter/exit via the sliding-side edge because the G1 slide
// physically engages the fork groove — you can't approach a fork from
// the wrong side and still align the tang. Cup has no lateral slide
// (it's a top-down drop into a cup that catches the tool holder), so it
// can enter and exit from WHICHEVER edge is closer to the origin/
// destination. That collapses rackEntrance's 4-move opposite-corner
// detour into a 2-move route:
//
//   1. Diagonal from origin to (originSideEdge, target.par)
//      — stays at or past the origin-side edge in perp axis, never
//        inside the keepout box on the way in.
//   2. Perp move to (target.perp, target.par)
//      — crosses into the keepout at the TARGET slot's par row, which
//        is fine because that's the slot we're aiming for; other slots
//        are at other par rows.
//
// Symmetric for cupExit (target → destination).
//
// Fallback: if origin sits INSIDE the keepout's perp range (workspace
// wedged into the rack, degenerate placement), defer to rackEntrance
// which handles that case with its opposite-corner logic.
// cupEntrance / cupExit force Cup routing semantics regardless of
// settings.rackHolding — some tests + call sites pass a bare settings
// object without the field, but the intent (calling a "cup" function)
// is unambiguous.
function cupEntrance(engaged, origin, settings) {
  const cupSettings = settings.rackHolding === 'Cup' ? settings : { ...settings, rackHolding: 'Cup' };
  const waypoints = routePoint(origin, engaged, cupSettings, { edgeAnchor: origin });
  return `
    (cupEntrance: routePoint origin -> slot engaged.)
    ${waypointsToGCode(waypoints)}
  `.trim();
}

function cupExit(fromSlotEngaged, destination, settings) {
  const cupSettings = settings.rackHolding === 'Cup' ? settings : { ...settings, rackHolding: 'Cup' };
  const waypoints = routePoint(fromSlotEngaged, destination, cupSettings, { edgeAnchor: destination });
  return `
    (cupExit: routePoint slot engaged -> destination.)
    ${waypointsToGCode(waypoints)}
  `.trim();
}

// Slot approach → TLS. Route through the sliding-side edge (Fork
// engagement constraint) or origin-side edge (Cup).
function tlsEntrance(fromSlotXY, tlsX, tlsY, settings) {
  return rackExit(fromSlotXY, { x: tlsX, y: tlsY }, settings);
}

// TLS → destination (usually origin). Direct routePoint call — TLS is
// a standalone XY (not inside the rack), no ascent needed.
function tlsExit(tlsX, tlsY, origin, settings) {
  const waypoints = routePoint({ x: tlsX, y: tlsY }, origin, settings, { edgeAnchor: origin });
  return `
    (tlsExit: routePoint TLS -> destination.)
    ${waypointsToGCode(waypoints)}
  `.trim();
}

// Wrappers keep the existing call sites happy — rackExitToTLS is now
// tlsEntrance's back-compat name and rackExitToOrigin is a rackExit
// alias regardless of empty/loaded (routing doesn't depend on spindle
// load, only on the destination XY).
function rackExitToTLS(fromSlotXY, tlsX, tlsY, settings) {
  return tlsEntrance(fromSlotXY, tlsX, tlsY, settings);
}

function rackExitToOrigin(fromSlotXY, isEmpty, origin, settings) {
  return rackExit(fromSlotXY, origin, settings);
}


// === Clamp / unclamp sub-routines ===

function auxLineFor(settings, action) {
  const { on, off } = auxOnOff(settings.clampAuxOutput);
  // Fail-safe polarity: aux OFF (no power) holds the clamp; aux ON
  // releases it. So M6 uses M65 (or M9) to clamp and M64 (or M7/M8) to
  // release. If air / solenoid power is lost, the tool stays gripped.
  const cmd = action === 'clamp' ? off : on;
  return cmd || '(no clamp aux output configured)';
}

// === Safety sensors ===
//
// Air pressure. The read itself mirrors Sienci's P501 helper:
// `M66 P<n> L4 Q0.01` waits for the pressure input to read LOW with a 10ms
// timeout, and a timeout (#5399 == -1) is the fault — pressure OK is the LOW
// state on their wiring. Invert the port in firmware ($370) if the switch
// reads the other way round.
//
// P501 parks in a `while` loop until pressure returns, and that's the one
// thing we can't copy: grblHAL only allows o-word flow control when the
// program is read from a file on its own filesystem. Theirs is invoked as
// G65 P501 from the SD card; ours is streamed line by line, where a `while`
// answers error:80 ("Flow statement only allowed in filesystem macro") and
// takes the rest of the block down with it. Plain IF is fine streamed.
//
// So the retry is unrolled instead: read, and if it faults show the dialog
// and M0. The operator fixes the air and hits Re-check, which resumes into
// another read — a genuine re-verification, not an override. Three passes,
// and if pressure still hasn't returned the last dialog says plainly that
// continuing proceeds unverified, so nobody clicks through it believing the
// check passed.
//
// `oNum` is the base for this guard's o-word blocks; each guard site needs
// its own base, spaced far enough apart not to collide.
function pressureGuard(settings, oNum) {
  if (settings.pressureInput < 0) return '';
  const read = `M66 P${settings.pressureInput} L4 Q0.01\n    G4 P0.1`;
  const retry = (n) => `
    o${n} if [#5399 EQ -1]
      (MSG, PLUGIN_PNEUMATICATC:PRESSURE_FAULT)
      M0
      ${read}
    o${n} endif`;
  return `
    ${read}
    ${retry(oNum).trim()}
    ${retry(oNum + 1).trim()}
    o${oNum + 2} if [#5399 EQ -1]
      (MSG, PLUGIN_PNEUMATICATC:PRESSURE_FAULT_UNVERIFIED)
      M0
    o${oNum + 2} endif
  `.trim();
}

function slideFeedrate(settings) {
  return settings.slideSpeed > 0 ? settings.slideSpeed : 500;
}

function buildUnloadTool(settings, currentTool, slotPos, origin = { x: 0, y: 0 }) {
  if (currentTool === 0) return '';

  if (currentTool > settings.slots) {
    // Manual unload: park at manual position → dialog with [Release]
    // [Continue] → each button click sends `~`, advancing one step.
    // Release advances to open the drawbar (aux OFF); Continue advances
    // past the second M0 to run M61 Q0.
    return `
      G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
      G4 P0
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_UNLOAD_TOOL_${currentTool})
      M0
      ${auxLineFor(settings, 'unclamp')}
      M0
      M61 Q0
    `.trim();
  }

  // Drawbar back-off during unclamp — G1 retract from slot.z to
  // slot.z + DRAWBAR_OFFSET_MM at DRAWBAR_FEEDRATE_MMPM overlaps with
  // the pneumatic push so the holder stays on the cup / fork lip while
  // the drawbar pushes the tang down. Applies to both hold styles.
  const drawbarBackoff = `
      G53 G1 Z${settings.slot1.z + DRAWBAR_OFFSET_MM} F${DRAWBAR_FEEDRATE_MMPM}`;

  if (settings.rackHolding === 'Cup') {
    return `
      ${cupEntrance(slotPos.engaged, origin, settings)}
      G53 G0 Z${settings.slot1.z}
      G4 P0.5
      ${auxLineFor(settings, 'unclamp')}${drawbarBackoff}
      G4 P0.5
      ${pressureGuard(settings, 130)}
      G53 G0 Z${settings.zSafe}
      M61 Q0
    `.trim();
  }

  const feed = slideFeedrate(settings);
  return `
    ${rackEntrance(slotPos.engaged, origin, settings)}
    G53 G0 Z${settings.slot1.z}
    G53 G1 X${slotPos.engaged.x} Y${slotPos.engaged.y} F${feed}
    G4 P0.5
    ${auxLineFor(settings, 'unclamp')}${drawbarBackoff}
    G4 P0.5
    ${pressureGuard(settings, 140)}
    G53 G0 Z${settings.zSafe}
    M61 Q0
  `.trim();
}

function buildLoadTool(settings, toolNumber, slotPos, tlsRoutine, drawbarAlreadyReleased = false, origin = { x: 0, y: 0 }, chainedFromRack = false) {
  if (toolNumber === 0) return '';

  if (toolNumber > settings.slots) {
    // Manual load — dialog always shows the single-Clamp step
    // (MANUAL_CLAMP_TOOL), regardless of prior state. Two paths to get
    // there, differing only in whether we need to fire an auto-release
    // before showing the dialog:
    //   - drawbarAlreadyReleased=true — just unloaded a rack/manual tool,
    //     drawbar is already open. Straight to the dialog.
    //   - drawbarAlreadyReleased=false — coming from T0 (empty spindle,
    //     drawbar is in its fail-safe clamped rest state). No tool is
    //     in the spindle to drop, so auto-release the drawbar for the
    //     operator (with a short dwell for the pneumatics to actuate)
    //     and jump straight to the same insert-and-Clamp dialog.
    // Both paths converge on MANUAL_CLAMP_TOOL — operator just inserts
    // the bit, hits Clamp, hits Continue.
    var autoRelease = drawbarAlreadyReleased ? '' : `
      ${auxLineFor(settings, 'unclamp')}
      G4 P0.5`;
    return `
      G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
      G4 P0${autoRelease}
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_CLAMP_TOOL_${toolNumber})
      M0
      ${auxLineFor(settings, 'clamp')}
      M0
      M61 Q${toolNumber}
      ${tlsRoutine}
    `.trim();
  }

  // Loading from an empty spindle (T0 → Tn) leaves the drawbar in its
  // fail-safe clamped state, so we must release it before descending
  // onto the shank — otherwise the collet is closed on contact and the
  // tool never enters. Coming from a prior unload the drawbar is
  // already open, so skip the extra release + dwell.
  const releaseFirst = drawbarAlreadyReleased ? '' : `
      G4 P0.5
      ${auxLineFor(settings, 'unclamp')}
      G4 P0.5
      ${pressureGuard(settings, 150)}`;

  // Approach-to-engaged sequence differs by chain context AND hold style:
  //   * chainedFromRack=true (Tm→Tn swap, fork or cup): machine is already
  //     at slot m engaged, Z-safe. Slot n engaged sits in the same rack
  //     row — a single par walk at Z-safe passes over the tools sitting
  //     in the intermediate slots (spindle is above them). One move.
  //   * chainedFromRack=false (T0→Tn or manual→Tn):
  //     - Fork: rackEntrance (must enter via sliding-side edge for the
  //             G1 slide-in), then a G0 perp step to engaged.
  //     - Cup:  cupEntrance (2-move route via ORIGIN-side edge; no slide
  //             so no reason to force sliding-side entry). Second move is
  //             already to engaged.xy, no extra G0 needed.
  const approachToEngaged = chainedFromRack
    ? `G53 G0 X${slotPos.engaged.x} Y${slotPos.engaged.y}`
    : settings.rackHolding === 'Cup'
      ? cupEntrance(slotPos.engaged, { x: origin?.x ?? 0, y: origin?.y ?? 0 }, settings)
      : `${rackEntrance(slotPos.engaged, { x: origin?.x ?? 0, y: origin?.y ?? 0 }, settings)}
        G53 G0 X${slotPos.engaged.x} Y${slotPos.engaged.y}`;

  // Drawbar forward-seat during clamp — mirror of buildUnloadTool's
  // back-off. Approach at slot.z + DRAWBAR_OFFSET_MM, clamp, then G1
  // descend to slot.z at DRAWBAR_FEEDRATE_MMPM overlapping with the
  // pneumatic pull-up so the holder stays on the cup / fork lip while
  // the drawbar pulls the tang up. Applies to both hold styles.
  const approachZ   = settings.slot1.z + DRAWBAR_OFFSET_MM;
  const drawbarSeat = `
      G53 G1 Z${settings.slot1.z} F${DRAWBAR_FEEDRATE_MMPM}`;

  if (settings.rackHolding === 'Cup') {
    return `
      ${approachToEngaged}${releaseFirst}
      G53 G0 Z${approachZ}
      G4 P0.5
      ${auxLineFor(settings, 'clamp')}${drawbarSeat}
      G4 P0.5
      G53 G0 Z${settings.zSafe}
      M61 Q${toolNumber}
      ${tlsRoutine}
    `.trim();
  }

  const feed = slideFeedrate(settings);
  return `
    ${approachToEngaged}${releaseFirst}
    G53 G0 Z${approachZ}
    G4 P0.5
    ${auxLineFor(settings, 'clamp')}${drawbarSeat}
    G4 P0.5
    G53 G1 X${slotPos.approach.x} Y${slotPos.approach.y} F${feed}
    G53 G0 Z${settings.zSafe}
    M61 Q${toolNumber}
    ${tlsRoutine}
  `.trim();
}

function buildManualSwap(settings, toolNumber, tlsRoutine) {
  // Manual → Manual: one physical park, one dialog. Buttons Release
  // (aux OFF, opens drawbar) → user swaps bits → Clamp (aux ON, closes
  // drawbar) → Continue advances past the final M0 to M61 + TLS.
  return `
    G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
    G4 P0
    (MSG, PLUGIN_PNEUMATICATC:MANUAL_SWAP_TOOL_${toolNumber})
    M0
    ${auxLineFor(settings, 'unclamp')}
    M0
    ${auxLineFor(settings, 'clamp')}
    M0
    M61 Q${toolNumber}
    ${tlsRoutine}
  `.trim();
}

function buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets = { x: 0, y: 0 }, storedTlo = 0, origin = { x: 0, y: 0 }) {
  const sourceSlot = calculateSlotPosition(settings, currentTool);
  const targetSlot = calculateSlotPosition(settings, toolNumber);
  // Probing decision:
  //   'always'  — probe on every M6.
  //   'library' — probe only when the tool has no TLO stored yet
  //               (|storedTlo| < 0.0001). If a stored value exists we
  //               inject `G43.1 Z<value>` instead of the probe routine
  //               so the controller still gets the offset loaded.
  //   (No tool assigned to slot / unknown toolNumber → storedTlo is 0 → probe.)
  const hasStoredTlo = Math.abs(storedTlo || 0) > 0.0001;
  const shouldProbe = settings.tlsMode === 'always'
    || (settings.tlsMode === 'library' && !hasStoredTlo);

  // Rack-fork gate: if we're loading a real rack tool via fork, wrap the
  // TLS entry with a safe rack exit so the trip from slot approach to
  // the toolsetter routes around the rack (par-first for same-side TLS;
  // corner detour for opposite-side TLS). Manual tools skip this — the
  // manual station isn't in the rack routing model. Rack slots (both
  // fork and cup styles) share the routing model since the keepout box
  // is derived purely from slot geometry, not from how the tool is held.
  const isRackSlot = toolNumber > 0
    && toolNumber <= settings.slots;
  // When the routine is chained after rackExitToTLS/cupExit, we're
  // already parked at (tlsX, tlsY) from the routing above. Tell the
  // routine to skip its own XY approach so we don't emit the redundant
  // edge-hop-back-to-TLS pair.
  const chainedFromRackExit = shouldProbe && isRackSlot;
  const rawTlsRoutine = shouldProbe
    ? createToolLengthSetRoutine(settings, toolOffsets, { skipXYApproach: chainedFromRackExit, originMPos: origin }).join('\n')
    : (settings.tlsMode === 'library' && hasStoredTlo
        ? `(Load stored TLO from tool library)\n    G43.1 Z${storedTlo}`
        : '');
  const tlsX = settings.toolsetter.x + (toolOffsets.x || 0);
  const tlsY = settings.toolsetter.y + (toolOffsets.y || 0);
  const tlsRoutine = chainedFromRackExit
    ? `${settings.rackHolding === 'Cup'
        ? cupExit(targetSlot.engaged, { x: tlsX, y: tlsY }, settings)
        : rackExitToTLS(targetSlot.engaged, tlsX, tlsY, settings)}\n${rawTlsRoutine}`
    : rawTlsRoutine;

  // Every time we probe (both modes), arm the writeback so the next
  // [TLO:xxx] response from the controller gets saved into the tool's
  // library entry. 'always' mode still probes on every M6 — the writeback
  // just keeps the library value fresh so it's accurate as a reference.
  if (shouldProbe && toolNumber > 0
      && typeof pluginContext !== 'undefined'
      && pluginContext
      && typeof pluginContext.armTlsWriteback === 'function') {
    try { pluginContext.armTlsWriteback(toolNumber); } catch (_) { /* older host */ }
  }

  // Manual → Manual: unload + load happen at the same physical spot,
  // so collapse them into a single dialog+move via buildManualSwap.
  // Otherwise: any unload path — rack or manual — leaves the drawbar
  // released, and a manual load that follows uses the CLAMP dialog.
  const isManualToManual = currentTool > settings.slots && toolNumber > settings.slots;
  const drawbarAlreadyReleased = currentTool > 0;
  const unloadSection = isManualToManual
    ? ''
    : buildUnloadTool(settings, currentTool, sourceSlot, origin);

  // Chained rack swap: an unload just placed the machine at the source
  // slot's engaged position at Z-safe. Slot N's engaged sits in the
  // same rack row, so we can par-walk directly to it at Z-safe (over
  // the tools in the intermediate slots — spindle nose is above them).
  // Any other flow (T0→Tn, manual→Tn) has to route in through the
  // padded slot entry. Applies to both Fork and Cup — both leave the
  // machine at slot engaged, Z-safe, after unload.
  const chainedFromRack = !isManualToManual
    && currentTool > 0
    && currentTool <= settings.slots;

  const loadSection = isManualToManual
    ? buildManualSwap(settings, toolNumber, tlsRoutine)
    : buildLoadTool(settings, toolNumber, targetSlot, tlsRoutine, drawbarAlreadyReleased, origin, chainedFromRack);

  // Tx → T0 leaves the drawbar released after the unload (there is no
  // load section to re-clamp). Restore the fail-safe clamped state so
  // the spindle isn't sitting with the collet open at rest.
  const finalizeUnclamped = (toolNumber === 0 && unloadSection)
    ? `G4 P0.5\n    ${auxLineFor(settings, 'clamp')}\n    G4 P0.5`
    : '';

  // Exit routing — pick the right "get back to origin" path based on
  // what actually happened during the macro. Manual paths skip this
  // since the manual station isn't inside the rack routing model. Rack
  // slots (fork or cup) do participate — the keepout box and exit
  // detour geometry are the same regardless of hold style.
  //   * Probed a rack tool → spindle is at the toolsetter; tlsExit.
  //   * Unloaded to T0 (any rack slot) → spindle empty at source approach; direct diagonal.
  //   * Loaded a rack tool without probing → spindle loaded at target approach; runtime-branched exit.
  //   * Otherwise (manual / T0→T0) → leave as-is; existing sequence handles it.
  let exitSection = '';
  const isCup = settings.rackHolding === 'Cup';
  if (isRackSlot && shouldProbe) {
    exitSection = tlsExit(tlsX, tlsY, origin, settings);
  } else if (toolNumber === 0 && currentTool > 0 && currentTool <= settings.slots) {
    exitSection = isCup
      ? cupExit(sourceSlot.engaged, origin, settings)
      : rackExitToOrigin(sourceSlot.engaged, /* isEmpty */ true, origin, settings);
  } else if (isRackSlot && !shouldProbe) {
    exitSection = isCup
      ? cupExit(targetSlot.engaged, origin, settings)
      : rackExitToOrigin(targetSlot.engaged, /* isEmpty */ false, origin, settings);
  }

  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';

  const gcode = `
    (Start of PneumaticATC Plugin Sequence)
    ${preCmd}
    #<return_units> = [20 + #<_metric>]
    G21
    M5
    ${pressureGuard(settings, 120)}
    G53 G0 Z${settings.zSafe}
    ${unloadSection}
    ${loadSection}
    G53 G0 Z${settings.zSafe}
    ${finalizeUnclamped}
    ${exitSection}
    G4 P0
    G[#<return_units>]
    ${postCmd}
    (End of PneumaticATC Plugin Sequence)
  `.trim();

  return formatGCode(gcode);
}

// === Command handlers ===

function expandIntoCommands(commands, index, originalCommand, programLines, settings) {
  const showMacroCommand = settings.showMacroCommand ?? false;
  const expanded = programLines.map((line, i) => {
    if (i === 0) {
      return {
        command: line,
        displayCommand: showMacroCommand ? null : originalCommand.trim(),
        isOriginal: false
      };
    }
    return {
      command: line,
      displayCommand: null,
      isOriginal: false,
      meta: showMacroCommand ? {} : { silent: true }
    };
  });
  commands.splice(index, 1, ...expanded);
}

function handleTLSCommand(commands, context, settings) {
  const idx = commands.findIndex((c) => c.isOriginal && c.command.trim().toUpperCase() === '$TLS');
  if (idx === -1) return;
  const currentTool = context.machineState?.tool ?? 0;
  const toolOffsets = getToolProbeOffsets(currentTool, context.tools);
  // Standalone $TLS probes the currently-loaded tool — save the result
  // back to library regardless of strategy so the value stays accurate.
  if (currentTool > 0
      && typeof pluginContext !== 'undefined'
      && pluginContext
      && typeof pluginContext.armTlsWriteback === 'function') {
    try { pluginContext.armTlsWriteback(currentTool); } catch (_) { /* older host */ }
  }
  // Current machine XY at the moment $TLS was invoked. Cup routing
  // uses this to pick the origin-side perp edge (matches cupEntrance);
  // Fork routing ignores it (sliding-side is forced).
  const mpos = context.machineState?.mpos;
  const originMPos = (mpos && typeof mpos.x === 'number' && typeof mpos.y === 'number')
    ? { x: mpos.x, y: mpos.y }
    : undefined;
  const program = createToolLengthSetProgram(settings, toolOffsets, { originMPos });
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

function handleHomeCommand(commands, context, settings) {
  const idx = commands.findIndex((c) => c.isOriginal && c.command.trim().toUpperCase() === '$H');
  if (idx === -1) return;
  if (!settings.performTlsAfterHome) return;

  const currentTool = context.machineState?.tool ?? 0;
  const toolOffsets = getToolOffsets(currentTool, context.tools);
  // After $H the spindle is at the home position (typically 0,0 with
  // grblHAL "set machine origin to 0" bit). Passing that as origin
  // lets Cup routing pick the correct edge.
  const mpos = context.machineState?.mpos;
  const originMPos = (mpos && typeof mpos.x === 'number' && typeof mpos.y === 'number')
    ? { x: mpos.x, y: mpos.y }
    : { x: 0, y: 0 };
  const tlsRoutine = createToolLengthSetRoutine(settings, toolOffsets, { originMPos }).join('\n');
  const tlsExitMove = createToolLengthSetExitMove(settings, toolOffsets, { originMPos });
  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';

  const gcode = `
    $H
    #<return_units> = [20 + #<_metric>]
    o100 IF [[#<_tool_offset> EQ 0] AND [#<_current_tool> NE 0]]
      ${preCmd}
      G21
      ${tlsRoutine}
      G53 G0 Z${settings.zSafe}
      ${tlsExitMove}
      G4 P0
      G53 G0 X0 Y0
      ${postCmd}
    o100 ENDIF
    G[#<return_units>]
  `.trim();
  const program = formatGCode(gcode);
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

// Manual $slotN navigation. Routes through the same keepout-safe
// entrance used by tool change (buildLoadTool / buildUnloadTool). A
// direct G0 XY from an origin on the wrong side of the rack would
// otherwise cut straight through the keepout envelope over the other
// tools — the whole reason cupEntrance / rackEntrance exist.
function buildSlotNav(settings, slotNum, origin = { x: 0, y: 0 }) {
  const engaged = calculateSlotPosition(settings, slotNum).engaged;
  const entrance = settings.rackHolding === 'Cup'
    ? cupEntrance(engaged, origin, settings)
    : `${rackEntrance(engaged, origin, settings)}
       G53 G0 X${engaged.x} Y${engaged.y}`;
  return `
    G53 G21 G90 G0 Z${settings.zSafe}
    ${entrance}
  `.trim();
}

function handleSlotCommand(commands, context, settings) {
  const idx = commands.findIndex((c) => {
    if (!c.isOriginal) return false;
    return parseSlotCommand(c.command) !== null;
  });
  if (idx === -1) return;

  const slotNum = parseSlotCommand(commands[idx].command);
  if (slotNum === null) return;
  // Silently ignore out-of-range references so a typo doesn't move to a
  // fallback position — the user probably meant a slot they'll add later.
  if (slotNum < 1 || slotNum > settings.slots) return;

  const origin = {
    x: context?.machineState?.mpos?.x ?? 0,
    y: context?.machineState?.mpos?.y ?? 0,
  };
  const gcode = buildSlotNav(settings, slotNum, origin);
  const program = formatGCode(gcode);
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

function handleM6Command(commands, context, settings) {
  const idx = commands.findIndex((c) => {
    if (!c.isOriginal) return false;
    const parsed = parseM6Command(c.command);
    return parsed?.matched && parsed.toolNumber !== null;
  });
  if (idx === -1) return;

  const parsed = parseM6Command(commands[idx].command);
  if (!parsed?.matched || parsed.toolNumber === null) return;
  const toolNumber = parsed.toolNumber;
  const currentTool = context.machineState?.tool ?? 0;
  const toolOffsets = getToolProbeOffsets(toolNumber, context.tools);
  const storedTlo = getStoredTlo(toolNumber, context.tools);
  // Pre-M6 machine XY snapshot — rack routing branches on this at
  // gcode-generation time. Requires the host to expose
  // context.machineState.mpos.{x,y}; falls back to (0,0) on older
  // hosts (path may be suboptimal but still lands at destination).
  const origin = {
    x: context.machineState?.mpos?.x ?? 0,
    y: context.machineState?.mpos?.y ?? 0,
  };
  const program = buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets, storedTlo, origin);
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

// === Main entry point ===

// Module-scoped edition marker. Set at the top of every onBeforeCommand
// call from the current context.edition so downstream helpers (formatGCode
// in particular) can gate Pro-only behavior — currently the `$keepout_off`
// prefix on G53 rack routing. Defaults to non-pro when the marker is
// missing so an older core without this field falls back safely.
let _coreEdition = 'unknown';

// Reject an aux-ON (M64) command that would release the pneumatic collet
// while the spindle is spinning. Aux-OFF (M65) is fail-safe clamp so it
// doesn't need gating. Matches only the configured clampAuxOutput — jobs
// that legitimately toggle other aux outputs (dust boot, coolant, laser)
// pass through untouched. Rejected command is replaced with a visible
// comment so the operator can see WHY the release didn't fire.
//
// Runs first in onBeforeCommand — this covers every source (terminal,
// macros, job g-code, plugin-expanded routines from other plugins) since
// they all funnel through here. The plugin's OWN tool-change program
// spins the spindle down before firing M64, so this gate is a no-op on
// the happy path; it catches accidents.
function gateSpindleUnclamp(commands, context, settings) {
  var clampAux = settings.clampAuxOutput;
  if (!Number.isFinite(clampAux)) return;
  if (!context || !context.machineState || !context.machineState.spindleActive) return;

  var unclampPattern = new RegExp('(^|[^A-Z])M0*64(\\s+P0*' + clampAux + ')(\\s|$|;|\\()', 'i');
  for (var i = 0; i < commands.length; i++) {
    var cmd = commands[i];
    if (!cmd.isOriginal) continue;
    var stripped = cmd.command.trim().replace(/^N\d+\s+/i, '');
    if (!unclampPattern.test(stripped)) continue;
    // Replace with a rejection comment sent to grblHAL (no-op) but keep
    // the terminal display anchored to what the operator typed, with the
    // reason appended so it reads as one line: `M64 P2 (BLOCKED: spindle
    // active — unclamp refused)`. Original command is preserved as
    // display text; the actual bytes on the wire are pure comment.
    var originalDisplay = (cmd.displayCommand || cmd.command).trim().replace(/^N\d+\s+/i, '');
    var reason = 'BLOCKED: spindle active - unclamp refused';
    var comment = '(' + originalDisplay + ' ' + reason + ')';
    commands[i] = {
      command: comment,
      displayCommand: originalDisplay + '  (' + reason + ')',
      isOriginal: false,
      meta: {}
    };
  }
}

function onBeforeCommand(commands, context, settings) {
  _coreEdition = (context && typeof context.edition === 'string') ? context.edition : 'unknown';
  if (context && context.safeZHeight !== undefined) {
    settings.zSafe = context.safeZHeight;
  }
  gateSpindleUnclamp(commands, context, settings);
  handleHomeCommand(commands, context, settings);
  handleTLSCommand(commands, context, settings);
  handleSlotCommand(commands, context, settings);
  handleM6Command(commands, context, settings);
  return commands;
}

export {
  onBeforeCommand, buildInitialConfig,
  rackEntrance, rackExit, cupEntrance, cupExit, tlsEntrance, tlsExit,
  computeKeepoutZone, slotEntryPoint, slotApproachPoint,
  buildLoadTool, buildUnloadTool, buildSlotNav, calculateSlotPosition,
  gateSpindleUnclamp,
  createToolLengthSetRoutine, createToolLengthSetProgram,
  routePoint, pickEntryEdge,
};
