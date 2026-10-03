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
// Upper bound for the probe's tool number. Matches the config UI's max and
// the two-digit T-word the macro emits.
const MAX_TOOL_NUMBER = 99;

// Pneumatic drawbar compensation for CUP-style racks only. On a cup rack
// the tool holder rests on the cup lip and the drawbar's actuation would
// otherwise push the holder up out of / down into the taper. A tiny
// (1 mm) G1 in the opposite direction at a slow feed (matches the
// solenoid's ~200 ms actuation time) neutralises that motion so the
// holder stays on the cup lip throughout. Fork racks slide horizontally
// into/out of engagement and don't need this — omitted below.
const DRAWBAR_OFFSET_MM = 1;
const DRAWBAR_FEEDRATE_MMPM = 300;

// Taper blow / cone clean. On the Sienci kit the taper-blow port is teed off
// the drawbar valve, so air blasts out through the collet the whole time the
// drawbar is open. Sienci's TC.macro works with that in three ways, and with
// `taperBlow` on we do the same:
//   * unload: lift off the holder, then CLOSE the drawbar right there, so the
//     blow isn't venting across the whole traverse to the next slot;
//   * load: arrive above the slot clamped, open the drawbar there, dwell for
//     the air to vent (and blow the taper), then feed down the last stretch
//     slowly with the blow running so chips are cleared off the holder;
//   * a longer settle after the clamp before trusting it.
// With it off (a spindle with no blow port connected) the chained swap keeps
// the drawbar open between slots — nothing is venting, so nothing to save.
// Numbers are Sienci's published values.
const DEDUST_LIFT_MM = 20;
const DEDUST_FEEDRATE_MMPM = 1500;
const DEDUST_VENT_SEC = 0.8;
const DEDUST_CLAMP_SETTLE_SEC = 1;

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

// Probe auto-loader. The probe is treated as one more tool, so its number
// has to clear every rack slot (slot N is tool N) — hence the slots + 1
// floor. Defaults to T99, the far end of the range, so it stays out of the
// way no matter how large the rack grows.
const PROBE_TOOL_DEFAULT = 99;
// `rack` supplies the fallbacks for the fork fields: a holder set up beside
// the rack most likely slides the same way, so an unset probe inherits the
// rack's direction, distance and speed, and slides along the rack's slide
// axis (the one perpendicular to its orientation).
const sanitizeProbe = (raw = {}, slots = 1, rack = {}) => {
  const floor = slots + 1;
  const parsed = Number.parseInt(raw.toolNumber, 10);
  const toolNumber = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, floor), MAX_TOOL_NUMBER)
    : Math.max(floor, PROBE_TOOL_DEFAULT);
  return {
    enabled: !!raw.enabled,
    toolNumber,
    holding: raw.holding === 'Cup' ? 'Cup' : 'Fork',
    // Fork motion for the probe holder. Independent of the rack's: the rack
    // may be on Cup while the probe sits in a fork, or slide the other way.
    slideAxis: raw.slideAxis === 'Y' ? 'Y' : raw.slideAxis === 'X' ? 'X'
             : (sanitizeOrientation(rack.orientation) === 'Y' ? 'X' : 'Y'),
    slideDirection: sanitizeSlideDirection(raw.slideDirection ?? rack.slideDirection),
    slideDistance: toFiniteNumber(raw.slideDistance, toFiniteNumber(rack.slideDistance, 40)),
    slideSpeed: toFiniteNumber(raw.slideSpeed, toFiniteNumber(rack.slideSpeed, 500)),
    x: toFiniteNumber(raw.x),
    y: toFiniteNumber(raw.y),
    z: toFiniteNumber(raw.z, -100),
    verify: sanitizeProbeVerify(raw.verify, raw.verifyGcode, toFiniteNumber(raw.z, -100))
  };
};

// Verification that the probe actually works, run after the pickup and
// before its TLS. Two ways to describe it:
//   simple   — one number, the machine Z at which the needle tip is level
//              with the holder's mount. The routine is generated from it
//              (see probeVerifyRoutine).
//   advanced — the operator's own G-code, seeded from the simple routine
//              when they switch over.
// `legacyGcode` is the pre-split `verifyGcode` string: non-empty meant a
// custom routine (advanced), empty meant no check.
const sanitizeProbeVerify = (raw, legacyGcode, holderZ) => {
  const hasRaw = raw && typeof raw === 'object';
  const legacy = typeof legacyGcode === 'string' ? legacyGcode.trim() : '';
  const mode = hasRaw
    ? (raw.mode === 'advanced' ? 'advanced' : 'simple')
    : (legacy ? 'advanced' : 'simple');
  return {
    enabled: hasRaw ? raw.enabled !== false : !!legacy,
    mode,
    // Default a little above the holder so a first run is a free move
    // rather than a crash; the operator sets it from the Probe page.
    z: toFiniteNumber(hasRaw ? raw.z : undefined, holderZ + 20),
    gcode: hasRaw ? (raw.gcode ?? '') : legacy
  };
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

const SIENCI_SLIDE_SPEED = 2000;   // mm/min, Sienci's published fork-slide feed

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
    // The Sienci kit's slide speed is fixed (the field is locked). Imperial
    // configs saved before the settings screen converted the profile value
    // hold 2000 x 25.4 = 50800 mm/min, so the kit value is used, not the
    // stored one.
    slideSpeed: raw.atcProfile === 'sienci' ? SIENCI_SLIDE_SPEED : toFiniteNumber(raw.slideSpeed, 500),
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
    tlsMode: sanitizeTlsMode(raw.tlsMode, raw.performTlsOnToolChange),

    slot1: { x: toFiniteNumber(slot1Raw.x), y: toFiniteNumber(slot1Raw.y), z: toFiniteNumber(slot1Z, -100) },
    slot1Z: toFiniteNumber(slot1Z, -100),
    slotCoords: raw.slotCoords || [],
    toolsetter: sanitizeCoords2D(raw.toolsetter ?? raw.toolSetter),
    manualTool: sanitizeCoords2D(raw.manualTool),
    probe: sanitizeProbe(raw.probe, slots, raw),

    zSafe: toFiniteNumber(raw.zSafe, 0),

    tlsSeekStartZ: toFiniteNumber(raw.tlsSeekStartZ, toFiniteNumber(raw.zSafe, -5)),
    seekDistance: toFiniteNumber(raw.seekDistance, 50),
    seekFeedrate: toFiniteNumber(raw.seekFeedrate, 500),

    preToolChangeGcode: raw.preToolChangeGcode ?? '',
    postToolChangeGcode: raw.postToolChangeGcode ?? '',
    abortEventGcode: raw.abortEventGcode ?? '',

    // Rack preset picked in Advanced (e.g. 'sienci'). Only read for
    // firmware-specific behaviour such as Sienci's keepout (see sienciKeepout).
    atcProfile: typeof raw.atcProfile === 'string' ? raw.atcProfile : '',

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
    // grblHAL aux INPUT carrying the drawbar-position switch (Sienci's
    // _tc_input_db — a reed switch on the cylinder). -1 = not wired.
    drawbarInput: sanitizeAuxInput(raw.drawbarInput),
    // grblHAL aux INPUT carrying the tool-in-spindle sensor (Sienci's
    // _tc_input_tis — pullstud / spindle proximity). -1 = not wired.
    toolSensorInput: sanitizeAuxInput(raw.toolSensorInput),
    // Retractable tool rack: a digital output extends the rack into position
    // for a load/unload and retracts it clear afterward, so it doesn't sit in
    // the machining envelope during a job. Only driven when switched on AND an
    // output is chosen (see rackActive). A config saved without the switch
    // keeps its old meaning: on exactly when an output was set.
    // Two independent end-stop sensors, NOT one sensor read both ways — a
    // single sensor can't tell "stuck mid-travel" from either confirmed end.
    // Each is optional on its own; skipping one just leaves that actuation
    // unverified. Both read OK = HIGH; invert via $370 if wired the other way.
    toolRackEnabled: raw.toolRackEnabled === undefined
      ? sanitizeAuxOutput(raw.toolRackAuxOutput) !== -1
      : !!raw.toolRackEnabled,
    toolRackAuxOutput: sanitizeAuxOutput(raw.toolRackAuxOutput),
    toolRackAvailableSensorInput: sanitizeAuxInput(raw.toolRackAvailableSensorInput),
    toolRackUnavailableSensorInput: sanitizeAuxInput(raw.toolRackUnavailableSensorInput),
    // Taper blow / cone clean plumbed off the drawbar valve (Sienci kit).
    // See DEDUST_* above for what it changes in the sequence.
    taperBlow: !!raw.taperBlow,

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

// Tool-id concept: a T number is the Tool ID (the tool, not the pocket), so
// the library is searched by Tool ID first; a slot is only a fallback.
// Offsets belong to the tool, never the slot.
function findTool(toolNumber, tools) {
  return tools.find((t) => t.toolId === toolNumber)
    || tools.find((t) => t.toolNumber === toolNumber);
}

// The sequence builders think in physical positions: 1..slots is a rack slot,
// the probe number is the probe, anything above the rack is a hand-loaded
// tool. toPhysical() maps a Tool ID onto that: the slot the library puts it
// in, else a hand-tool number (MANUAL_BASE + id, always above any rack).
// idOf() maps back so M61, messages and the TLO writeback carry the Tool ID.
const MANUAL_BASE = 1000;
let _physToId = new Map();
function idOf(n) {
  return _physToId.has(n) ? _physToId.get(n) : n;
}
function toPhysical(id, settings, tools) {
  if (!id || id <= 0) return 0;
  if (isProbeTool(settings, id)) return id;
  const list = Array.isArray(tools) ? tools : [];
  const tool = list.find((t) => t.toolId === id);
  let phys;
  if (tool) {
    const slot = Number.isInteger(tool.toolNumber) ? tool.toolNumber : 0;
    phys = slot >= 1 && slot <= settings.slots ? slot : MANUAL_BASE + id;
  } else {
    // Not in the library. Keep the old meaning (T = slot) only while that
    // slot isn't holding some other identified tool; an empty library
    // therefore behaves exactly as before.
    const occupant = list.find((t) => t.toolNumber === id);
    phys = id <= settings.slots && (!occupant || occupant.toolId == null) ? id : MANUAL_BASE + id;
  }
  _physToId.set(phys, id);
  return phys;
}

function getToolProbeOffsets(toolNumber, tools) {
  if (!toolNumber || toolNumber <= 0 || !Array.isArray(tools)) {
    return { x: 0, y: 0, z: 0 };
  }
  const tool = findTool(toolNumber, tools);
  if (tool && tool.offsets) {
    return { x: tool.offsets.x || 0, y: tool.offsets.y || 0, z: tool.offsets.tlsZ || 0 };
  }
  return { x: 0, y: 0, z: 0 };
}

function getStoredTlo(toolNumber, tools) {
  if (!toolNumber || toolNumber <= 0 || !Array.isArray(tools)) return 0;
  const tool = findTool(toolNumber, tools);
  if (!tool || !tool.offsets) return 0;
  return tool.offsets.z || 0;
}

// Back-compat alias for older call sites within this file.
const getToolOffsets = getToolProbeOffsets;

// === G-code helpers ===

// Withholds the `$keepout_off` prefix from a single line (see formatGCode,
// which strips the marker before the line is sent).
const CORE_CHECKED_MARKER = '(ncs-checked)';

// Every G53 leg this plugin emits is rack routing it computed itself and
// can vouch for — except the last one. The exit legs end at `returnTo`,
// which is wherever the operator happened to leave the spindle when they
// typed M6, and cancelling a tool load leaves it parked INSIDE the rack.
// Blanket-prefixing that leg asserts a safety property this plugin has no
// basis to assert, and drives the spindle back into the studs.
//
// Hand just that leg to the core's keepout check instead: if the
// destination is clear it runs exactly as before, and if it is inside the
// zone the core refuses it and the spindle stays at the rack edge — the
// position the exit routing just brought it to, which is known safe.
function handFinalLegToCoreCheck(section) {
  if (!section) return section;
  const lines = section.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(^|[^A-Z])G0*53(?:[^0-9]|$)/i.test(lines[i])) {
      lines[i] = `${lines[i]} ${CORE_CHECKED_MARKER}`;
      break;
    }
  }
  return lines.join('\n');
}

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
    // A leg marked by handFinalLegToCoreCheck keeps its keepout check.
    const coreChecked = line.includes(CORE_CHECKED_MARKER);
    const emitted = coreChecked
      ? line.replace(CORE_CHECKED_MARKER, '').trimEnd()
      : line;
    const prefixed = (isMachineMove && !coreChecked && _coreEdition === 'pro')
      ? `$keepout_off ${emitted}`
      : emitted;
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

// === Keeping a Z0 that was set before any Tool Length Reference ===
//
// The offset applied here is absolute: G43.1 Z<machine Z where the tool
// touched the setter>, so work Z = machine Z - G5x Z - TLO. A Z0 set AFTER a
// reference exists is right for every tool. A Z0 set BEFORE one (TLO still 0)
// goes wrong the moment the first TLS applies an offset: everything shifts by
// the whole touch height and the next cut plunges — the "zero first, TLS
// later" habit gSender users bring with them.
//
// The host reports it (machineState.zeroSetWithoutTlr / zeroTool). While the
// tool that set that Z0 is still in the spindle we keep it by paying the first
// applied offset back into the work offset, so G5x Z + TLO does not change:
//   'keepSelf'  measure this tool, apply its offset, shift G5x Z by it.
//   'reference' measure the tool that set Z0, only remember its touch height.
//   'keepRef'   measure the new tool, apply its offset, shift G5x Z by the
//               remembered height of the tool that set Z0.
// The work offset is written after the offset is active and announced, so the
// host never mistakes it for a fresh unreferenced Z0.
// How close the outgoing tool's reference touch must land to its library TLO
// for the library to be trusted this boot (the kiosk repeats within a few
// microns; a stale library entry is off by far more).
const REF_MATCH_TOLERANCE_MM = 0.05;

function zeroKeepPlan(context, currentTool) {
  const ms = (context && context.machineState) || {};
  const pending = ms.zeroSetWithoutTlr === true && ms.toolLengthSet !== true;
  const zeroTool = typeof ms.zeroTool === 'number' ? ms.zeroTool : 0;
  return { keep: pending && zeroTool === currentTool, swapped: pending && zeroTool !== currentTool };
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

  // options.mode — see zeroKeepPlan. 'reference' only remembers the touch
  // height: no offset, no host notification and no [#] dump, so a TLO
  // writeback armed for the NEXT tool is not consumed by this measurement.
  // 'measure' only applies the offset: used inside a controller-side if/else,
  // where grblHAL still runs `$` lines of the branch it skips, so the host
  // notification and [#] dump are emitted by the caller after the endif.
  const mode = options.mode || 'normal';
  const applyOffset = mode === 'reference'
    ? `(Remember the touch height of the tool that set Z0)
    #<_nc_ref_tlo> = #<_nc_last_tlo>`
    : mode === 'measure'
    ? `G43.1 Z[#<_nc_last_tlo>]`
    : `G43.1 Z[#<_nc_last_tlo>]
    (Notify ncSender that toolLengthSet is now set)
    $#=_tool_offset${mode === 'keepSelf' ? `
    (Keep the Z0 that was set before this reference)
    G10 L2 P[#5220] Z[#<_cur_wcs_z_ofs> - #<_nc_last_tlo>]` : ''}${mode === 'keepRef' ? `
    (Keep the Z0 that was set with the previous tool)
    G10 L2 P[#5220] Z[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>]` : ''}
    (Trigger a full [#] dump so ncSender receives [TLO:xxx] for writeback)
    $#`;

  const gcode = `
    G53 G0 Z${settings.zSafe}
    ${tlsApproach}
    ${approach}
    ${preTls}
    G43.1 Z0
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G4 P0.2
    G38.4 G91 Z5 F25
    G91 G0 Z5
    G90
    ${postTls}
    #<_ofs_idx> = [#5220 * 20 + 5203]
    #<_cur_wcs_z_ofs> = #[#<_ofs_idx>]
    #<_nc_last_tlo> = [#5063 + #<_cur_wcs_z_ofs>]
    ${applyOffset}
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

// A user's Pre/Post Tool Change g-code deliberately runs in the PROGRAM's
// units, not the plugin's: it is spliced outside the G21 wrapper that makes
// the plugin's own (millimetre) config correct. That stays -- someone running
// an inch post is thinking in inches, and the snippet reads as part of their
// program.
//
// What must not survive is a modal word set inside the snippet. Write G21 in
// Post Tool Change "to be safe" on an inch program and every remaining line
// of the job silently becomes millimetres; write G91 and the rest goes
// incremental. Either corrupts the whole run with no error and no clue at the
// machine -- the same shape as the dropped-line bug that cost a customer a
// job, arriving by a different door.
//
// So the snippet is bracketed: capture units and distance mode before it, put
// them back after. grblHAL exposes both read-only (_metric, _absolute).
// Feed is deliberately NOT restored: #<_feed> is 0 until the program sets
// one, and emitting F0 is worse than the leak it would prevent. Most posts
// re-state F on the next cutting move.
function modalSafe(snippet, tag) {
  const body = String(snippet || '').trim();
  if (!body) return '';
  return `#<${tag}_units> = [20 + #<_metric>]
    #<${tag}_dist> = [91 - #<_absolute>]
    ${body}
    G[#<${tag}_units>]
    G[#<${tag}_dist>]`;
}

// Post Tool Change runs once the new tool is in and the spindle has left the
// rack (or the tool setter) at safe Z, BEFORE the final leg back to where the
// change started. It used to run after that leg: a routine that picks up a
// dust shoe drove back to the work first, went off to the dust shoe, and the
// job then moved back again. The final leg is the one handed to the core's
// keepout check (handFinalLegToCoreCheck), so the trip back from wherever the
// routine leaves the spindle is still checked.
//
// splitFinalLeg separates that leg from the rest of an exit; leg is '' when
// the exit has none (manual / probe-holder paths, endAtTls), and then the
// event keeps running at the very end as before.
function splitFinalLeg(exit) {
  if (!exit) return { body: exit || '', leg: '' };
  const lines = exit.split('\n');
  const i = lines.findIndex((l) => l.includes(CORE_CHECKED_MARKER));
  if (i < 0) return { body: exit, leg: '' };
  return { body: lines.slice(0, i).join('\n'), leg: lines.slice(i).join('\n') };
}

// The event in the program's units (see modalSafe), then back to millimetres,
// safe Z, and the final leg.
function postToolChangeThenLeg(postCmd, leg, settings) {
  return `G4 P0
    G[#<return_units>]
    ${modalSafe(postCmd, 'post')}
    G21
    G53 G0 Z${settings.zSafe}
    ${leg.trim()}`;
}

function createToolLengthSetProgram(settings, toolOffsets = { x: 0, y: 0, z: 0 }, options = {}) {
  const tlsRoutine = createToolLengthSetRoutine(settings, toolOffsets, options).join('\n');
  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';
  // Both callers ($TLS and Measure All Tools' "already in the spindle" step)
  // probe on the toolsetter, which needs the rack extended the same as any
  // rack-slot interaction — baked in here once rather than in each caller.
  // No-ops when the rack isn't switched on and configured.
  const rackExtend = extendToolRack(settings, 430);
  const rackRetract = retractToolRack(settings, 440);
  let tlsExitMove = createToolLengthSetExitMove(settings, toolOffsets, options);
  // With the origin known the exit ends there; run Post Tool Change before
  // that last move, which then goes through the core's keepout check.
  let postAtEnd = !!postCmd;
  if (postCmd && options.originMPos && tlsExitMove) {
    const { body, leg } = splitFinalLeg(handFinalLegToCoreCheck(tlsExitMove));
    if (leg) {
      tlsExitMove = `${body}
    ${postToolChangeThenLeg(postCmd, leg, settings)}`;
      postAtEnd = false;
    }
  }

  const gcode = `
    (Start of Tool Length Setter)
    ${modalSafe(preCmd, 'pre')}
    #<return_units> = [20 + #<_metric>]
    G21
    ${rackExtend}
    ${tlsRoutine}
    G53 G0 Z${settings.zSafe}
    ${tlsExitMove}
    ${rackRetract}
    G4 P0
    G[#<return_units>]
    ${postAtEnd ? modalSafe(postCmd, 'post') : ''}
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
//
// `freeEdge` drops the Fork constraint and picks by geometry for any
// holding style. For a path that never touches a slot — TLS back to the
// origin — the fork's engagement side is irrelevant, and forcing it sent
// the spindle to the far edge of the keepout, along its whole width, and
// back down the other side when the destination sat just past the near
// edge (reported on a 12-slot Sienci rack: ~240 mm of pointless travel).
function pickEntryEdge(settings, edgeAnchor, freeEdge = false) {
  const orientationY = settings.orientation === 'Y';
  const pad = settings.keepoutPadding ?? settings.slideDistance ?? 0;
  const slot1Perp = orientationY ? settings.slot1.x : settings.slot1.y;
  const perpMin = slot1Perp - pad;
  const perpMax = slot1Perp + pad;

  if (freeEdge || settings.rackHolding === 'Cup') {
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
// options.freeEdge — pick the edge by geometry even on a Fork rack. Only
//   for paths that don't touch a slot (see pickEntryEdge).
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
  const entryPerp = pickEntryEdge(settings, edgeAnchor, !!options.freeEdge);
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
// a standalone XY (not inside the rack), no ascent needed, and no slot is
// touched, so the keepout edge is picked by geometry (nearest the
// destination) rather than forced to the fork's sliding side.
function tlsExit(tlsX, tlsY, origin, settings) {
  const waypoints = routePoint({ x: tlsX, y: tlsY }, origin, settings, { edgeAnchor: origin, freeEdge: true });
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
// Air pressure. Mirrors Sienci's P501 helper: `M66 P<n> L4 Q<t>` waits for
// the pressure input to read LOW, and a timeout (#5399 == -1) is the fault —
// pressure OK is the LOW state on their wiring. Invert the port in firmware
// ($370) if the switch reads the other way round.
//
// Read ONCE, before anything moves — exactly where Sienci's TC.macro calls
// G65 P501, and nowhere else. An earlier version also re-read after every
// drawbar release, and that produced a false "Air Pressure Low" on a real
// machine: with the drawbar open the input sat HIGH for seconds while the
// gauge read fine, so a pressure read there does not mean what we wanted it
// to mean. Sienci verifies the release with the drawbar sensor instead, which
// is a different input we don't read yet (see PLAN-sienci-safety-inputs.md).
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
// `oNum` is the base for this guard's o-word blocks. The supply is at rest
// when this runs, so a short wait is enough: it is either there or it isn't.
const PRESSURE_WAIT_SEC = 0.5;
function pressureGuard(settings, oNum) {
  if (!auxInputConfigured(settings.pressureInput)) return '';
  const read = `M66 P${settings.pressureInput} L4 Q${PRESSURE_WAIT_SEC}\n    G4 P0.1`;
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

// Drawbar position and tool-in-spindle. Two inputs Sienci reads that we
// did not until now (_tc_input_db and _tc_input_tis).
//
// They answer different questions and both are worth having:
//   * The drawbar switch says the MECHANISM moved. It is the honest way to
//     confirm a release actually happened — the thing the pressure input
//     cannot tell us. A pressure read taken right after a release reports
//     the transient, not the supply (see the pressureGuard note above), so
//     this is the input that closes that hole.
//   * The tool sensor says the OUTCOME is right: a tool is gripped when one
//     should be, and the spindle is clear when it should be.
//
// Ordering matters. The drawbar checks sit before the Z move that depends
// on them, so a drawbar that never closed is caught BEFORE the spindle
// lifts a tool it is not holding. The tool checks sit after that lift,
// where "is there a tool in the spindle" is finally a settled question.
//
// Read convention, shared by both guards and chosen so there is exactly one
// fault condition in the whole file: `L4` waits for the input to read LOW
// (asserted), `L3` waits for it to read HIGH (de-asserted), and either way
// a timeout leaves #5399 == -1. So `#5399 EQ -1` is always "the state we
// wanted never arrived" — same test as pressureGuard. Operators whose
// switch reads the other way round invert the port in firmware ($370),
// exactly as they already do for pressure.
//
// No unrolled retry here, unlike pressure. A compressor takes real time to
// recover, so re-reading it is worth something; a drawbar either actuated
// or it did not, and a tool is either in the spindle or it is not. Reading
// again changes nothing, so these fault once and stop.
//
// Pneumatics need longer than a pressure switch to finish moving.
const DRAWBAR_WAIT_SEC = 1;
const TOOL_SENSE_WAIT_SEC = 0.5;

// A sensor guard is only emitted for a real, configured pin. Checking
// `pin < 0` alone is not enough: an unsanitized settings object leaves these
// fields undefined, and `undefined < 0` is false, which would put a literal
// `M66 Pundefined` into a live tool change. Demand an actual integer >= 0.
const auxInputConfigured = (pin) => Number.isInteger(pin) && pin >= 0;

// `retreat` is optional: { safeZ, returnZ }. When given, a fault lifts the
// spindle clear of the rack before the operator is asked to do anything, and
// drops back down once they continue. Both moves live INSIDE the if-block, so
// a check that passes emits neither and the happy path is byte-for-byte what
// it was.
//
// The descent is not optional decoration. Continue resumes at the line after
// M0, and the rest of the sequence assumes the spindle is still where the
// check found it — on a fork load the very next move is the slide-out, which
// 100 mm too high would leave the tool in the rack. So whatever the lift
// raises, the return puts back.
//
// The lift is deliberately Z-only, straight up over the slot the tool is in.
// A lateral retreat is the tempting version and the dangerous one: the faults
// where the operator most wants their hands free are exactly the ones where
// we do not know the tool is held, and traversing with a loose tool throws
// it. Straight up means anything that comes free lands in or beside its own
// slot. The return is fed at drawbar speed rather than rapided because it can
// be descending onto a holder.
function sensorGuard(pin, oNum, waitSec, asserted, msgId, retreat) {
  const lift = retreat ? `G53 G0 Z${retreat.safeZ}` : '';
  const back = retreat ? `G53 G1 Z${retreat.returnZ} F${DRAWBAR_FEEDRATE_MMPM}` : '';
  return `
    M66 P${pin} ${asserted ? 'L4' : 'L3'} Q${waitSec}
    o${oNum} if [#5399 EQ -1]
      ${lift}
      (MSG, PLUGIN_PNEUMATICATC:${msgId})
      M0
      ${back}
    o${oNum} endif
  `.trim();
}

// expect: 'open' after an unclamp, 'closed' after a clamp.
function drawbarGuard(settings, oNum, expect, retreat) {
  if (!auxInputConfigured(settings.drawbarInput)) return '';
  const open = expect === 'open';
  return sensorGuard(
    settings.drawbarInput, oNum, DRAWBAR_WAIT_SEC, open,
    open ? 'DRAWBAR_FAILED_TO_OPEN' : 'DRAWBAR_FAILED_TO_CLOSE',
    retreat
  );
}

// expect: 'present' when a tool should now be gripped, 'empty' when the
// spindle should be clear.
function toolGuard(settings, oNum, expect, retreat) {
  if (!auxInputConfigured(settings.toolSensorInput)) return '';
  const present = expect === 'present';
  return sensorGuard(
    settings.toolSensorInput, oNum, TOOL_SENSE_WAIT_SEC, present,
    present ? 'TOOL_FAILED_TO_SEAT' : 'TOOL_STILL_GRIPPED',
    retreat
  );
}

// ncSender believes the spindle is empty (T0) while a tool is still seated —
// the usual case is a restart: the controller forgets the tool number on
// power-off, so it boots as T0 with whatever was left in the collet. Carrying
// on as if empty would release the drawbar and take a NEW tool into an
// occupied spindle. So a change that starts from T0 reads the tool sensor
// first, before anything else moves (and before the rack extends), and if a
// tool is there stops with a dialog.
//
// The plugin cannot tell WHICH tool it is, so it cannot put it back in the
// rack by itself. The operator has two ways out:
//   * Continue: the spindle parks at the manual station and the first dialog
//     asks them to support the tool; Continue opens the drawbar, a second
//     dialog asks them to take the tool out, and the change carries on from
//     empty.
//   * Abort, tell the controller which tool it is (M61 Q<n>, the Tool ID),
//     and run the change again: the tool is then unloaded into its own slot.
//     That is trust-based — nothing senses which slot a tool belongs to.
//
// Neither dialog has a custom button. The wireless pendant skips any dialog
// that does, and a Release button only ever sent `~` — the same resume that
// Continue does — so the release is a step of its own instead.
//
// Same polarity as toolGuard: present reads LOW, so `M66 L0` (an immediate
// read, no waiting) gives 0 when a tool is gripped. Both trips go around the
// rack keepout the way the probe holder's do, so the rest of the change still
// starts from `origin` as it assumes. Not emitted when no tool sensor pin is
// configured, or for a change that does nothing physical (T0 -> T0).
function unexpectedToolGuard(settings, oNum, origin) {
  if (!auxInputConfigured(settings.toolSensorInput)) return '';
  const park = probeRoute(origin, settings.manualTool, settings);
  const home = probeRoute(settings.manualTool, origin, settings, true);
  return `
    M66 P${settings.toolSensorInput} L0 Q0
    o${oNum} if [#5399 EQ 0]
      ${park}
      G4 P0
      (MSG, PLUGIN_PNEUMATICATC:UNEXPECTED_TOOL_DETECTED)
      M0
      ${auxLineFor(settings, 'unclamp')}
      G4 P0.5
      (MSG, PLUGIN_PNEUMATICATC:UNEXPECTED_TOOL_REMOVE)
      M0
      ${home}
    o${oNum} endif
  `.trim();
}

// === Retractable tool rack ===
//
// A rack mounted on an actuator that extends it into position for a
// load/unload and retracts it clear of the machining envelope the rest of
// the time. One digital output drives it (ON extends, OFF retracts); two
// independent end-stop inputs confirm each end of travel. The whole feature
// is off unless it is switched on (toolRackEnabled) and the output is
// configured.

// Unlike the drawbar and tool checks above, a rack actuator takes real time
// and can be helped along by hand, so this guard keeps the unrolled read /
// Re-check / Re-check / "continue unverified" shape of pressureGuard (see
// there for why it can't be a `while`). `oNum..oNum+2` are its o-word
// numbers; every call site needs its own, spaced to not collide in one macro.
// Returns '' for an unwired input.
function rackSensorGuard(input, faultMsg, unverifiedMsg, oNum) {
  if (!auxInputConfigured(input)) return '';
  const read = `M66 P${input} L3 Q0.01\n    G4 P0.1`;
  const retry = (n) => `
    o${n} if [#5399 EQ -1]
      (MSG, PLUGIN_PNEUMATICATC:${faultMsg})
      M0
      ${read}
    o${n} endif`;
  return `
    ${read}
    ${retry(oNum).trim()}
    ${retry(oNum + 1).trim()}
    o${oNum + 2} if [#5399 EQ -1]
      (MSG, PLUGIN_PNEUMATICATC:${unverifiedMsg})
      M0
    o${oNum + 2} endif
  `.trim();
}

// Two separate guards with their own dialogs: "rack didn't confirm
// available" and "rack didn't confirm retracted" mean different things to the
// operator. Both OK = HIGH (L3 waits for HIGH).
function toolRackAvailableGuard(settings, oNum) {
  return rackSensorGuard(settings.toolRackAvailableSensorInput, 'TOOLRACK_FAULT', 'TOOLRACK_FAULT_UNVERIFIED', oNum);
}
function toolRackUnavailableGuard(settings, oNum) {
  return rackSensorGuard(settings.toolRackUnavailableSensorInput, 'TOOLRACK_RETRACT_FAULT', 'TOOLRACK_RETRACT_FAULT_UNVERIFIED', oNum);
}

function rackOutputConfigured(settings) {
  return settings.toolRackAuxOutput === 'M7' || settings.toolRackAuxOutput === 'M8'
    || (typeof settings.toolRackAuxOutput === 'number' && settings.toolRackAuxOutput >= 0);
}

// The rack is only driven when it is switched on AND an output is chosen —
// an enabled rack with no output has nothing to drive. Only an explicit
// `false` switches it off: an unsanitized settings object that predates the
// toggle has no toolRackEnabled at all and keeps its old meaning (on exactly
// when an output is configured).
function rackActive(settings) {
  return settings.toolRackEnabled !== false && rackOutputConfigured(settings);
}

// Fire the rack actuator, then verify it got there if that end's sensor is
// wired. Each forces its own Z-safe move first rather than trusting the
// caller to already be at a safe height: moving the rack while the spindle is
// still down near slot depth risks the rack travelling into its path. A
// harmless no-op when the spindle is already there.
//
// G4 P0 forces a hard planner sync point: unlike two consecutive G0 moves,
// which the controller can blend instead of fully stopping in between, a
// dwell (even a zero-length one) can't start until all queued motion has
// truly come to rest. That's what keeps the rack from actuating while the
// Z-safe move above is still in flight — reported on hardware as the rack
// retracting while the spindle was still on its way up. The dwell time itself
// is moot, so there's nothing to configure.
//
// Returns '' entirely when the rack isn't switched on and configured.
function extendToolRack(settings, oNum) {
  if (!rackActive(settings)) return '';
  const { on } = auxOnOff(settings.toolRackAuxOutput);
  return `
    G53 G0 Z${settings.zSafe}
    G4 P0
    ${on}
    ${toolRackAvailableGuard(settings, oNum)}
  `.trim();
}
function retractToolRack(settings, oNum) {
  if (!rackActive(settings)) return '';
  const { off } = auxOnOff(settings.toolRackAuxOutput);
  return `
    G53 G0 Z${settings.zSafe}
    G4 P0
    ${off}
    ${toolRackUnavailableGuard(settings, oNum)}
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
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_UNLOAD_TOOL_${idOf(currentTool)})
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

  // Taper blow: lift clear of the holder, then close the drawbar so the
  // blow stops here instead of venting all the way to the next slot.
  const closeAfterLiftOff = settings.taperBlow ? `
      G53 G0 Z${settings.slot1.z + DEDUST_LIFT_MM}
      ${auxLineFor(settings, 'clamp')}
      G4 P0.5` : '';

  if (settings.rackHolding === 'Cup') {
    return `
      ${cupEntrance(slotPos.engaged, origin, settings)}
      G53 G0 Z${settings.slot1.z}
      G4 P0.5
      ${auxLineFor(settings, 'unclamp')}${drawbarBackoff}
      G4 P0.5
      ${drawbarGuard(settings, 200, 'open', { safeZ: settings.zSafe, returnZ: settings.slot1.z + DRAWBAR_OFFSET_MM })}${closeAfterLiftOff}
      G53 G0 Z${settings.zSafe}
      ${toolGuard(settings, 201, 'empty')}
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
    ${drawbarGuard(settings, 200, 'open', { safeZ: settings.zSafe, returnZ: settings.slot1.z + DRAWBAR_OFFSET_MM })}${closeAfterLiftOff}
    G53 G0 Z${settings.zSafe}
    ${toolGuard(settings, 201, 'empty')}
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
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_CLAMP_TOOL_${idOf(toolNumber)})
      M0
      ${auxLineFor(settings, 'clamp')}
      M0
      M61 Q${idOf(toolNumber)}
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
      ${drawbarGuard(settings, 210, 'open')}`;

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

  // Descent onto the holder. Taper blow: the drawbar was closed after the
  // unload (or is closed from rest), so open it here, directly above the
  // holder, let the air vent and blow the taper, then feed down the last
  // stretch slowly with the blow running. Otherwise: whatever release the
  // caller decided on, then a rapid to the approach height.
  const descend = settings.taperBlow ? `
      G53 G0 Z${settings.slot1.z + DEDUST_LIFT_MM}
      G4 P0.1
      ${auxLineFor(settings, 'unclamp')}
      G4 P${DEDUST_VENT_SEC}
      ${drawbarGuard(settings, 210, 'open', { safeZ: settings.zSafe, returnZ: settings.slot1.z + DEDUST_LIFT_MM })}
      G53 G1 Z${approachZ} F${DEDUST_FEEDRATE_MMPM}` : `${releaseFirst}
      G53 G0 Z${approachZ}`;
  const clampSettle = settings.taperBlow ? DEDUST_CLAMP_SETTLE_SEC : 0.5;

  if (settings.rackHolding === 'Cup') {
    return `
      ${approachToEngaged}${descend}
      G4 P0.5
      ${auxLineFor(settings, 'clamp')}${drawbarSeat}
      G4 P${clampSettle}
      ${drawbarGuard(settings, 211, 'closed', { safeZ: settings.zSafe, returnZ: settings.slot1.z })}
      ${toolGuard(settings, 212, 'present', { safeZ: settings.zSafe, returnZ: settings.slot1.z })}
      G53 G0 Z${settings.zSafe}
      M61 Q${idOf(toolNumber)}
      ${tlsRoutine}
    `.trim();
  }

  const feed = slideFeedrate(settings);
  return `
    ${approachToEngaged}${descend}
    G4 P0.5
    ${auxLineFor(settings, 'clamp')}${drawbarSeat}
    G4 P${clampSettle}
    ${drawbarGuard(settings, 211, 'closed', { safeZ: settings.zSafe, returnZ: settings.slot1.z })}
    ${toolGuard(settings, 212, 'present', { safeZ: settings.zSafe, returnZ: settings.slot1.z })}
    G53 G1 X${slotPos.approach.x} Y${slotPos.approach.y} F${feed}
    G53 G0 Z${settings.zSafe}
    M61 Q${idOf(toolNumber)}
    ${tlsRoutine}
  `.trim();
}

// === Probe auto-loader ===================================================
//
// The probe is one more tool: calling its number picks it up from its own
// holder the way a rack slot would, and calling any other tool while it is
// in the spindle puts it back. The holder is not part of the rack routing
// model — it can sit anywhere outside the rack keepout — so every trip to
// or from it is a routePoint around the keepout box, like the toolsetter.
// Its fork / cup motion is its own (settings.probe), so a Cup rack can
// still feed a fork-held probe and vice versa.

function isProbeTool(settings, toolNumber) {
  return !!(settings.probe && settings.probe.enabled)
    && toolNumber > 0
    && toolNumber === settings.probe.toolNumber;
}

// Holder geometry: `engaged` is where the probe sits; `approach` is where
// a fork slide starts / ends (the same point for a cup). `parked` is where
// the spindle is left after a pickup or put-down, at Z-safe.
function probeHolderPosition(settings) {
  const p = settings.probe;
  const engaged = { x: p.x, y: p.y };
  const cup = p.holding === 'Cup';
  if (cup) return { engaged, approach: engaged, parked: engaged, z: p.z, cup };
  const slideSign = p.slideDirection === 'Positive' ? 1 : -1;
  const off = -slideSign * (p.slideDistance || 0);
  const approach = p.slideAxis === 'Y'
    ? { x: engaged.x, y: engaged.y + off }
    : { x: engaged.x + off, y: engaged.y };
  // Fork: unload lifts off at engaged (probe stays in the fork); load
  // slides out to approach before lifting.
  return { engaged, approach, parked: null, z: p.z, cup };
}

// Simple-mode verification routine, run right after the pickup while the
// spindle is still at the holder. Rise to Verify Z (needle tip level with
// the holder's mount), go back over the holder's centre, then probe
// sideways toward the holder's edge: a working needle touches the rim
// within a few millimetres. G38.2 raises the controller's probe alarm if
// nothing is touched in the full travel, which aborts the tool change
// before the probe is ever driven at the toolsetter. Back to centre, up
// to safe Z, and the normal TLS follows. The sideways direction is the
// holder's slide axis and direction (into the fork; for a cup the same
// fields, which default from the rack).
const PROBE_VERIFY_TRAVEL_MM = 12;
const PROBE_VERIFY_FEED      = 150;
function probeVerifyRoutine(settings) {
  const p = settings.probe;
  const v = p.verify;
  const axis = p.slideAxis === 'Y' ? 'Y' : 'X';
  const sign = p.slideDirection === 'Positive' ? '' : '-';
  return `
    (Verify probe: touch the holder edge)
    G53 G0 Z${v.z}
    G53 G0 X${p.x} Y${p.y}
    G38.2 G91 ${axis}${sign}${PROBE_VERIFY_TRAVEL_MM} F${PROBE_VERIFY_FEED}
    G90
    G53 G0 X${p.x} Y${p.y}
    G53 G0 Z${settings.zSafe}
  `.trim().split('\n').map((l) => l.trim()).join('\n');
}

// The verification block that replaces the plain rise to safe Z after the
// pickup: nothing when it is off, the generated routine in simple mode,
// the operator's text in advanced mode. Either way the caller follows it
// with its own rise to safe Z, so a custom routine need not end there.
function probeVerifyGcode(settings) {
  const v = settings.probe && settings.probe.verify;
  if (!v || !v.enabled) return '';
  if (v.mode === 'advanced') return (v.gcode || '').trim();
  return probeVerifyRoutine(settings);
}

function probeSlideFeedrate(settings) {
  return settings.probe.slideSpeed > 0 ? settings.probe.slideSpeed : slideFeedrate(settings);
}

function probeRoute(from, to, settings, anchorAtDestination = false) {
  const waypoints = routePoint(from, to, settings, { edgeAnchor: anchorAtDestination ? to : from, freeEdge: true });
  return waypointsToGCode(waypoints);
}

// Put the probe back in its holder. `from` is where the spindle is now.
// Mirrors buildUnloadTool's rack branch with the holder's own geometry.
function buildProbeUnload(settings, from) {
  const h = probeHolderPosition(settings);
  const drawbarBackoff = `
      G53 G1 Z${h.z + DRAWBAR_OFFSET_MM} F${DRAWBAR_FEEDRATE_MMPM}`;
  const closeAfterLiftOff = settings.taperBlow ? `
      G53 G0 Z${h.z + DEDUST_LIFT_MM}
      ${auxLineFor(settings, 'clamp')}
      G4 P0.5` : '';

  if (h.cup) {
    return `
      (probeUnload: routePoint -> holder, drop into cup.)
      ${probeRoute(from, h.engaged, settings)}
      G53 G0 Z${h.z}
      G4 P0.5
      ${auxLineFor(settings, 'unclamp')}${drawbarBackoff}
      G4 P0.5
      ${drawbarGuard(settings, 220, 'open', { safeZ: settings.zSafe, returnZ: h.z + DRAWBAR_OFFSET_MM })}${closeAfterLiftOff}
      G53 G0 Z${settings.zSafe}
      ${toolGuard(settings, 221, 'empty')}
      M61 Q0
    `.trim();
  }

  const feed = probeSlideFeedrate(settings);
  return `
    (probeUnload: routePoint -> holder approach, slide into fork.)
    ${probeRoute(from, h.approach, settings)}
    G53 G0 Z${h.z}
    G53 G1 X${h.engaged.x} Y${h.engaged.y} F${feed}
    G4 P0.5
    ${auxLineFor(settings, 'unclamp')}${drawbarBackoff}
    G4 P0.5
    ${drawbarGuard(settings, 220, 'open', { safeZ: settings.zSafe, returnZ: h.z + DRAWBAR_OFFSET_MM })}${closeAfterLiftOff}
    G53 G0 Z${settings.zSafe}
    ${toolGuard(settings, 221, 'empty')}
    M61 Q0
  `.trim();
}

// Pick the probe up from its holder. `entrance` is the routing already
// worked out by the caller (rack exit when chained after a rack unload,
// otherwise a routePoint from wherever the spindle is). Mirrors
// buildLoadTool's rack branch. TLS always follows a probe pickup; the
// optional verify block runs first so a dead tip is caught before the
// probe is driven at the toolsetter.
function buildProbeLoad(settings, entrance, tlsRoutine, drawbarAlreadyReleased) {
  const h = probeHolderPosition(settings);
  const releaseFirst = drawbarAlreadyReleased ? '' : `
      G4 P0.5
      ${auxLineFor(settings, 'unclamp')}
      G4 P0.5
      ${drawbarGuard(settings, 230, 'open')}`;
  const approachZ   = h.z + DRAWBAR_OFFSET_MM;
  const drawbarSeat = `
      G53 G1 Z${h.z} F${DRAWBAR_FEEDRATE_MMPM}`;
  const descend = settings.taperBlow ? `
      G53 G0 Z${h.z + DEDUST_LIFT_MM}
      G4 P0.1
      ${auxLineFor(settings, 'unclamp')}
      G4 P${DEDUST_VENT_SEC}
      ${drawbarGuard(settings, 230, 'open', { safeZ: settings.zSafe, returnZ: h.z + DEDUST_LIFT_MM })}
      G53 G1 Z${approachZ} F${DEDUST_FEEDRATE_MMPM}` : `${releaseFirst}
      G53 G0 Z${approachZ}`;
  const clampSettle = settings.taperBlow ? DEDUST_CLAMP_SETTLE_SEC : 0.5;
  // The controller is told the probe is loaded (M61) as soon as it is
  // clamped and clear of the holder — before the verification, so a
  // failed check (alarm, abort) leaves the tool number matching what is
  // physically in the spindle. Verification runs while the spindle is
  // still at the holder, before the rise to safe Z (it rises to Verify Z
  // itself); the rise to safe Z that follows is harmless when the routine
  // already ended there.
  const verify = indentBlock(probeVerifyGcode(settings));
  const toolNumber = settings.probe.toolNumber;

  if (h.cup) {
    return `
      (probeLoad: lift out of cup.)
      ${entrance}${descend}
      G4 P0.5
      ${auxLineFor(settings, 'clamp')}${drawbarSeat}
      G4 P${clampSettle}
      ${drawbarGuard(settings, 231, 'closed', { safeZ: settings.zSafe, returnZ: h.z })}
      ${toolGuard(settings, 232, 'present', { safeZ: settings.zSafe, returnZ: h.z })}
      M61 Q${idOf(toolNumber)}
      ${verify}
      G53 G0 Z${settings.zSafe}
      ${tlsRoutine}
    `.trim();
  }

  const feed = probeSlideFeedrate(settings);
  return `
    (probeLoad: descend onto probe in fork, slide out.)
    ${entrance}
    G53 G0 X${h.engaged.x} Y${h.engaged.y}${descend}
    G4 P0.5
    ${auxLineFor(settings, 'clamp')}${drawbarSeat}
    G4 P${clampSettle}
    ${drawbarGuard(settings, 231, 'closed', { safeZ: settings.zSafe, returnZ: h.z })}
    ${toolGuard(settings, 232, 'present', { safeZ: settings.zSafe, returnZ: h.z })}
    G53 G1 X${h.approach.x} Y${h.approach.y} F${feed}
    M61 Q${idOf(toolNumber)}
    ${verify}
    G53 G0 Z${settings.zSafe}
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
    (MSG, PLUGIN_PNEUMATICATC:MANUAL_SWAP_TOOL_${idOf(toolNumber)})
    M0
    ${auxLineFor(settings, 'unclamp')}
    M0
    ${auxLineFor(settings, 'clamp')}
    M0
    M61 Q${idOf(toolNumber)}
    ${tlsRoutine}
  `.trim();
}

// options.forceTls — probe regardless of tlsMode / stored TLO (the
//   Measure All Tools batch uses this to refresh every value).
// options.endAtTls — after probing, stay parked at the toolsetter instead
//   of routing back to `origin`. The batch chains tool after tool from
//   there, so the trip back to the job and out again is skipped.
// options.returnTo — XY to route back to at the end instead of `origin`
//   (the batch's last step: unload from wherever we are, return to where
//   the operator started).
// options.tlrMissing — no Tool Length Reference is established on the
//   controller right now (host reports machineState.toolLengthSet false:
//   fresh boot / reset / G49). In 'library' mode a stored TLO is only
//   meaningful relative to that reference, so probe instead of loading it.
function buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets = { x: 0, y: 0 }, storedTlo = 0, origin = { x: 0, y: 0 }, options = {}) {
  const sourceSlot = calculateSlotPosition(settings, currentTool);
  const targetSlot = calculateSlotPosition(settings, toolNumber);
  // Probe auto-loader: the probe's tool number is handled by its own
  // holder sequences; it is neither a rack slot nor a manual tool.
  const sourceIsProbe = isProbeTool(settings, currentTool);
  const targetIsProbe = isProbeTool(settings, toolNumber);
  const holder = (sourceIsProbe || targetIsProbe) ? probeHolderPosition(settings) : null;
  // Where the spindle rests after the probe is picked up: at the holder's
  // centre when the verification ran (it ends there), otherwise where the
  // pickup itself finished — the slide-out point for a fork, the centre
  // for a cup. And after a put-down: both styles lift off at the centre.
  const verifyRuns = !!(settings.probe && settings.probe.verify && settings.probe.verify.enabled);
  const holderRestXY = holder
    ? ((verifyRuns || holder.cup) ? holder.engaged : holder.approach)
    : null;
  const holderUnloadRestXY = holder ? holder.engaged : null;
  // Probing decision:
  //   'always'  — probe on every M6.
  //   'library' — probe only when the tool has no TLO stored yet
  //               (|storedTlo| < 0.0001). If a stored value exists we
  //               inject `G43.1 Z<value>` instead of the probe routine
  //               so the controller still gets the offset loaded.
  //   (No tool assigned to slot / unknown toolNumber → storedTlo is 0 → probe.)
  //   'library' also probes when the controller has no Tool Length
  //   Reference yet (options.tlrMissing) — the first change after a boot
  //   re-establishes it even for a tool whose TLO is on file.
  const hasStoredTlo = Math.abs(storedTlo || 0) > 0.0001;
  // The probe follows the same strategy as any tool: with the library
  // strategy and a TLO on file for its tool number (the Tool Library's
  // "Probe" slot) the pickup loads the stored offset instead of probing.
  // A manual tool (numbered above the rack, not the probe) is fitted by hand,
  // so its stickout differs every time and a stored TLO can't be trusted:
  // always measure it, whatever the strategy.
  const targetIsManual = toolNumber > settings.slots && !isProbeTool(settings, toolNumber);
  const shouldProbe = !!options.forceTls
    || targetIsManual
    || settings.tlsMode === 'always'
    || (settings.tlsMode === 'library' && (!hasStoredTlo || !!options.tlrMissing));
  const returnTo = options.returnTo || origin;

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
  // After a probe pickup the spindle is at the holder, so the toolsetter
  // approach routes from there rather than from the pre-M6 origin.
  const tlsRouteFrom = targetIsProbe ? holderRestXY : origin;
  // Z0 set before a reference by the tool now in the spindle (zeroKeepPlan):
  // measure that tool first, then let the new tool's measurement keep the Z0.
  // Without a new tool to measure, fix the reference with the current tool.
  const keepZero = !!options.keepZero;
  const keepViaReference = keepZero && toolNumber !== 0 && shouldProbe;
  // With the library strategy and no reference yet the new tool would be
  // measured only to re-establish one — but keeping the Z0 already touches
  // the outgoing tool off. When that touch lands where the library says
  // (options.libraryIfRefMatches = the outgoing tool's stored TLO) the
  // library is good for this boot, so the new tool loads its stored TLO.
  // The touch value only exists on the controller, so the program carries
  // both endings and the controller picks one (see swapBody below).
  const refLibTlo = options.libraryIfRefMatches;
  const branchOnRef = keepViaReference
    && settings.tlsMode === 'library'
    && hasStoredTlo
    && isRackSlot
    && !targetIsProbe
    && !targetIsManual
    && !options.forceTls
    && typeof refLibTlo === 'number' && Math.abs(refLibTlo) > 0.0001;
  const rawTlsRoutine = shouldProbe
    ? createToolLengthSetRoutine(settings, toolOffsets, { skipXYApproach: chainedFromRackExit, originMPos: tlsRouteFrom, mode: branchOnRef ? 'measure' : (keepViaReference ? 'keepRef' : 'normal') }).join('\n')
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
    try { pluginContext.armTlsWriteback(idOf(toolNumber)); } catch (_) { /* older host */ }
  }

  // Manual → Manual: unload + load happen at the same physical spot,
  // so collapse them into a single dialog+move via buildManualSwap.
  // Otherwise: any unload path — rack or manual — leaves the drawbar
  // released, and a manual load that follows uses the CLAMP dialog.
  const isManualTool = (n) => n > settings.slots && !isProbeTool(settings, n);
  const isManualToManual = isManualTool(currentTool) && isManualTool(toolNumber);
  // A rack (or holder) unload with the taper blow on re-clamps after
  // lifting off, so the drawbar is NOT left open for the load that follows.
  const rackUnloadReclamped = settings.taperBlow && currentTool > 0 && currentTool <= settings.slots;
  const probeUnloadReclamped = settings.taperBlow && sourceIsProbe;
  const drawbarAlreadyReleased = currentTool > 0 && !rackUnloadReclamped && !probeUnloadReclamped;
  // Where the swap starts from. Normally the pre-M6 position; after the
  // extra touch-off that keeps a Z0 (see zeroKeepPlan) the spindle is at the
  // toolsetter, so route the unload straight from there instead of driving
  // back to the job first. The final exit still returns to `returnTo`.
  const currentOffsets = options.currentOffsets || { x: 0, y: 0, z: 0 };
  const swapFrom = keepZero
    ? { x: settings.toolsetter.x + (currentOffsets.x || 0), y: settings.toolsetter.y + (currentOffsets.y || 0) }
    : origin;
  const unloadSection = isManualToManual
    ? ''
    : sourceIsProbe
      ? buildProbeUnload(settings, swapFrom)
      : buildUnloadTool(settings, currentTool, sourceSlot, swapFrom);

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

  // Where the spindle is when the load begins: still at the pre-M6 origin
  // for T0, at the holder after a probe put-down, at the slot after a rack
  // unload (buildLoadTool handles that chain itself).
  const loadFrom = sourceIsProbe ? holderUnloadRestXY : swapFrom;
  let loadSection;
  if (isManualToManual) {
    loadSection = buildManualSwap(settings, toolNumber, tlsRoutine);
  } else if (targetIsProbe) {
    // Entrance to the holder approach: leave the rack properly when
    // chained after a rack unload, otherwise route from wherever we are
    // (origin, or the manual station after a manual unload).
    const fromXY = isManualTool(currentTool) ? settings.manualTool : swapFrom;
    const entrance = chainedFromRack
      ? (settings.rackHolding === 'Cup'
          ? cupExit(sourceSlot.engaged, holder.approach, settings)
          : rackExit(sourceSlot.engaged, holder.approach, settings))
      : probeRoute(fromXY, holder.approach, settings);
    loadSection = buildProbeLoad(settings, entrance, tlsRoutine, drawbarAlreadyReleased);
  } else {
    loadSection = buildLoadTool(settings, toolNumber, targetSlot, tlsRoutine, drawbarAlreadyReleased, loadFrom, chainedFromRack);
  }

  // Tx → T0 leaves the drawbar released after the unload (there is no
  // load section to re-clamp). Restore the fail-safe clamped state so
  // the spindle isn't sitting with the collet open at rest.
  const finalizeUnclamped = (toolNumber === 0 && unloadSection && !rackUnloadReclamped && !probeUnloadReclamped)
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
  if (targetIsProbe && shouldProbe) {
    // Probe picked up and measured → spindle is at the toolsetter.
    exitSection = options.endAtTls ? '' : tlsExit(tlsX, tlsY, returnTo, settings);
  } else if (targetIsProbe) {
    // Probe picked up, stored TLO applied, no TLS → spindle is still at the
    // holder at safe Z. Route home from there, around the rack keepout.
    exitSection = `(probeExit: routePoint holder -> destination.)\n    ${probeRoute(holderRestXY, returnTo, settings, true)}`;
  } else if (sourceIsProbe && toolNumber === 0) {
    // Probe put down, spindle empty at the holder → route home.
    exitSection = `(probeExit: routePoint holder -> destination.)\n    ${probeRoute(holderUnloadRestXY, returnTo, settings, true)}`;
  } else if (isRackSlot && shouldProbe) {
    exitSection = options.endAtTls ? '' : tlsExit(tlsX, tlsY, returnTo, settings);
  } else if (toolNumber === 0 && currentTool > 0 && currentTool <= settings.slots) {
    exitSection = isCup
      ? cupExit(sourceSlot.engaged, returnTo, settings)
      : rackExitToOrigin(sourceSlot.engaged, /* isEmpty */ true, returnTo, settings);
  } else if (isRackSlot && !shouldProbe) {
    exitSection = isCup
      ? cupExit(targetSlot.engaged, returnTo, settings)
      : rackExitToOrigin(targetSlot.engaged, /* isEmpty */ false, returnTo, settings);
  }

  // `returnTo` is operator-chosen, not plugin-computed — the one
  // destination in this program the plugin cannot vouch for.
  exitSection = handFinalLegToCoreCheck(exitSection);

  // Retractable rack: extend once, before any motion toward a rack slot;
  // retract once, after everything is done, including the exit / toolsetter
  // routing and the final leg — NOT between unload and load, since a chained
  // Tm→Tn swap par-walks between two rack slots with the rack deployed the
  // whole time. Either side of the change touching a rack slot is enough; a
  // pure manual / probe-holder change never needs it. Extend goes in front of
  // the Z0 carry-over touch-off too, so the whole swap runs with the rack out.
  const touchesRack = (currentTool > 0 && currentTool <= settings.slots)
    || (toolNumber > 0 && toolNumber <= settings.slots);
  const rackExtend = touchesRack ? extendToolRack(settings, 400) : '';
  const rackRetract = touchesRack ? retractToolRack(settings, 410) : '';
  // A change that starts from "empty" checks that it really is (see
  // unexpectedToolGuard). Before the rack extends, so no dialog shows with it out.
  const unexpectedTool = (currentTool === 0 && toolNumber !== 0)
    ? unexpectedToolGuard(settings, 250, origin)
    : '';

  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';
  // Post Tool Change goes in front of the final leg (see splitFinalLeg).
  const exitSplit = splitFinalLeg(exitSection);
  let postAtEnd = !!postCmd;

  // Controller-side choice between the library ending and the measured one
  // (see branchOnRef). Only g-code lives inside the branches; the `$` host
  // notification, the Z0 carry-over and the [#] dump that feeds the TLO
  // writeback run after the endif, for whichever ending ran. On the library
  // ending that writeback stores the value the tool already had.
  let exitWithPost = exitSection;
  if (postCmd && exitSplit.leg) {
    exitWithPost = `${exitSplit.body}
    ${postToolChangeThenLeg(postCmd, exitSplit.leg, settings)}`;
    postAtEnd = false;
  }
  let swapBody = `${loadSection}
    G53 G0 Z${settings.zSafe}
    ${finalizeUnclamped}
    ${exitWithPost}`;
  if (branchOnRef) {
    const libLoad = buildLoadTool(settings, toolNumber, targetSlot,
      `(Load stored TLO from tool library)\n    G43.1 Z${storedTlo}`,
      drawbarAlreadyReleased, loadFrom, chainedFromRack);
    const libExit = handFinalLegToCoreCheck(isCup
      ? cupExit(targetSlot.engaged, returnTo, settings)
      : rackExitToOrigin(targetSlot.engaged, /* isEmpty */ false, returnTo, settings));
    // Both endings finish with the same final leg to returnTo. Keep it, and
    // Post Tool Change, out of the branches and run them after the endif:
    // grblHAL executes `$` lines even inside the branch it skips, and the
    // event is the operator's own g-code.
    const libSplit = splitFinalLeg(libExit);
    const shareLeg = !!postCmd && !!exitSplit.leg && libSplit.leg.trim() === exitSplit.leg.trim();
    const libEnding = shareLeg ? libSplit.body : libExit;
    const measuredEnding = shareLeg ? exitSplit.body : exitSection;
    postAtEnd = !!postCmd && !shareLeg;
    swapBody = `#<_nc_lib_ok> = [ABS[#<_nc_ref_tlo> - [${refLibTlo}]] LT ${REF_MATCH_TOLERANCE_MM}]
    o7101 if [#<_nc_lib_ok>]
    (T${idOf(currentTool)} touched off where the library says: load T${idOf(toolNumber)} from the library)
    ${libLoad}
    G53 G0 Z${settings.zSafe}
    ${libEnding}
    o7101 else
    (T${idOf(currentTool)} touched off away from its library value: measure T${idOf(toolNumber)})
    ${loadSection}
    G53 G0 Z${settings.zSafe}
    ${measuredEnding}
    o7101 endif
    (Notify ncSender that toolLengthSet is now set)
    $#=_tool_offset
    #<_ofs_idx> = [#5220 * 20 + 5203]
    #<_cur_wcs_z_ofs> = #[#<_ofs_idx>]
    (Keep the Z0 that was set with the previous tool)
    G10 L2 P[#5220] Z[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>]
    (Trigger a full [#] dump so ncSender receives [TLO:xxx] for writeback)
    $#${shareLeg ? `
    ${postToolChangeThenLeg(postCmd, exitSplit.leg, settings)}` : ''}`;
  }

  // Out to the toolsetter; the unload below routes on from there (swapFrom).
  const zeroKeepSection = keepZero
    ? `(Measure T${idOf(currentTool)} first: it set Z0 before a tool length reference existed)
    (MSG, ZERO_KEEP_START T${idOf(currentTool)})
    ${createToolLengthSetRoutine(settings, currentOffsets, { originMPos: origin, mode: keepViaReference ? 'reference' : 'keepSelf' }).join('\n')}
    G53 G0 Z${settings.zSafe}
    (MSG, ZERO_KEEP_END)`
    : '';

  const gcode = `
    (Start of PneumaticATC Plugin Sequence)
    ${modalSafe(preCmd, 'pre')}
    #<return_units> = [20 + #<_metric>]
    G21
    M5
    ${sienciKeepout(settings).off}
    ${pressureGuard(settings, 120)}
    G53 G0 Z${settings.zSafe}
    ${unexpectedTool}
    ${rackExtend}
    ${zeroKeepSection}
    ${unloadSection}
    ${swapBody}
    ${rackRetract}
    G4 P0
    ${sienciKeepout(settings).on}
    G[#<return_units>]
    ${postAtEnd ? modalSafe(postCmd, 'post') : ''}
    (End of PneumaticATC Plugin Sequence)
  `.trim();

  return formatGCode(gcode);
}

// Sienci's grblHAL build has its own keepout zone around the rack (turned
// on and off with M960 P1 / M960 P0) and alarms when the ATC moves into it.
// With the Sienci profile the plugin turns it off before any move into the
// rack and back on when the change is done, so users don't have to add
// those lines to the Pre/Post Tool Change events themselves.
function sienciKeepout(settings) {
  const on = settings.atcProfile === 'sienci';
  return {
    off: on ? 'M960 P0 (Sienci keepout off for the rack)' : '',
    on:  on ? 'M960 P1 (Sienci keepout back on)' : '',
  };
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
  const program = createToolLengthSetProgram(settings, toolOffsets, {
    originMPos,
    mode: zeroKeepPlan(context, currentTool).keep ? 'keepSelf' : 'normal',
  });
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

// === Measure All Tools ===
//
// One step of the "Measure all tools" batch that the config dialog's TLS
// tab drives. The dialog sends one command per tool so that the host's
// one-shot TLO writeback (armTlsWriteback → next [TLO:]) is armed for a
// single tool at a time — arming several at once would write the first
// value to all of them. The dialog waits for each command to finish before
// sending the next, tracks progress from the [TLO:] replies, and cancels
// with feed hold + soft reset.
//
//   $MEASURE_TLO T<n>            load tool n (swapping out whatever is in
//                                the spindle), probe it whatever the TLS
//                                strategy or stored value says, save it,
//                                and stay parked at the toolsetter.
//   $MEASURE_TLO T<n>            with n already in the spindle: just probe.
//   $MEASURE_TLO T0 X<x> Y<y>    put the current tool away and return to
//                                X Y (where the operator started).
function parseMeasureTloCommand(command) {
  const m = /^\$MEASURE_TLO\b(.*)$/i.exec(command.trim());
  if (!m) return null;
  const args = m[1];
  const t = /\bT(\d+)/i.exec(args);
  if (!t) return null;
  const x = /\bX(-?\d+(?:\.\d+)?)/i.exec(args);
  const y = /\bY(-?\d+(?:\.\d+)?)/i.exec(args);
  return {
    toolNumber: parseInt(t[1], 10),
    returnTo: (x && y) ? { x: parseFloat(x[1]), y: parseFloat(y[1]) } : null,
  };
}

function handleMeasureTloCommand(commands, context, settings) {
  const idx = commands.findIndex((c) => c.isOriginal && parseMeasureTloCommand(c.command));
  if (idx === -1) return;
  const req = parseMeasureTloCommand(commands[idx].command);
  const toolNumber = req.toolNumber;
  const currentTool = context.machineState?.tool ?? 0;
  _physToId = new Map();
  const physTarget = toPhysical(toolNumber, settings, context.tools);
  const physCurrent = toPhysical(currentTool, settings, context.tools);
  const origin = {
    x: context.machineState?.mpos?.x ?? 0,
    y: context.machineState?.mpos?.y ?? 0,
  };

  let program;
  if (toolNumber > 0 && toolNumber === currentTool) {
    // Already in the spindle: probe it where it is. Same as $TLS, and the
    // writeback is armed the same way.
    const toolOffsets = getToolProbeOffsets(currentTool, context.tools);
    if (typeof pluginContext !== 'undefined' && pluginContext
        && typeof pluginContext.armTlsWriteback === 'function') {
      try { pluginContext.armTlsWriteback(currentTool); } catch (_) { /* older host */ }
    }
    program = createToolLengthSetProgram(settings, toolOffsets, {
      originMPos: origin,
      mode: zeroKeepPlan(context, currentTool).keep ? 'keepSelf' : 'normal',
    });
  } else if (toolNumber > 0) {
    const toolOffsets = getToolProbeOffsets(toolNumber, context.tools);
    const storedTlo = getStoredTlo(toolNumber, context.tools);
    program = buildToolChangeProgram(settings, physCurrent, physTarget, toolOffsets, storedTlo, origin,
      { forceTls: true, endAtTls: true,
        keepZero: zeroKeepPlan(context, currentTool).keep,
        currentOffsets: getToolProbeOffsets(currentTool, context.tools) });
  } else {
    program = buildToolChangeProgram(settings, physCurrent, 0, { x: 0, y: 0 }, 0, origin,
      { returnTo: req.returnTo || origin });
  }
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
  // Parks in the rack, so the Sienci keepout is only turned off here; the
  // next tool change turns it back on when it finishes.
  // Extend before jogging over the slot — same reasoning as the M6 path. No
  // retract afterward: the operator jogged here deliberately (setup /
  // inspection) and likely wants to stay, unlike a tool change where the rack
  // has to be clear again before the job resumes.
  return `
    G53 G21 G90 G0 Z${settings.zSafe}
    ${extendToolRack(settings, 420)}
    ${sienciKeepout(settings).off}
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
  _physToId = new Map();
  const physTarget = toPhysical(toolNumber, settings, context.tools);
  const physCurrent = toPhysical(currentTool, settings, context.tools);
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
  // Older hosts don't expose toolLengthSet at all (undefined) — only a
  // definite `false` means "no reference"; otherwise trust the library.
  const tlrMissing = context.machineState?.toolLengthSet === false;
  // Only a rack or probe tool's library TLO says anything about this boot; a
  // hand-fitted manual tool's stickout changes every time.
  const currentIsTrusted = physCurrent > 0
    && (physCurrent <= settings.slots || isProbeTool(settings, physCurrent));
  const program = buildToolChangeProgram(settings, physCurrent, physTarget, toolOffsets, storedTlo, origin, {
    tlrMissing,
    keepZero: zeroKeepPlan(context, currentTool).keep,
    currentOffsets: getToolProbeOffsets(currentTool, context.tools),
    libraryIfRefMatches: currentIsTrusted ? getStoredTlo(currentTool, context.tools) : undefined,
  });
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
  handleTLSCommand(commands, context, settings);
  handleMeasureTloCommand(commands, context, settings);
  handleSlotCommand(commands, context, settings);
  handleM6Command(commands, context, settings);
  return commands;
}

export {
  onBeforeCommand, buildInitialConfig, probeVerifyRoutine, probeVerifyGcode,
  rackEntrance, rackExit, cupEntrance, cupExit, tlsEntrance, tlsExit,
  computeKeepoutZone, slotEntryPoint, slotApproachPoint,
  buildLoadTool, buildUnloadTool, buildSlotNav, calculateSlotPosition,
  buildToolChangeProgram, parseMeasureTloCommand,
  gateSpindleUnclamp,
  createToolLengthSetRoutine, createToolLengthSetProgram,
  routePoint, pickEntryEdge,
};
