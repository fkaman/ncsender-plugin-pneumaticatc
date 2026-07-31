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
const MAX_SLOTS = 8;

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
    slotDistance: toFiniteNumber(raw.slotDistance ?? raw.pocketDistance, 45),
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
    zRetract: toFiniteNumber(raw.zRetract ?? raw.zRetreat, 7),

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
    formatted.push(indent + line);
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

function createToolLengthSetRoutine(settings, toolOffsets = { x: 0, y: 0, z: 0 }) {
  const tlsX = settings.toolsetter.x + (toolOffsets.x || 0);
  const tlsY = settings.toolsetter.y + (toolOffsets.y || 0);
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
    G53 G0 X${tlsX} Y${tlsY}
    ${approach}
    ${preTls}
    G43.1 Z0
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G4 P0.2
    G38.4 G91 Z5 F75
    G91 G0 Z5
    G90
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

function createToolLengthSetProgram(settings, toolOffsets = { x: 0, y: 0, z: 0 }) {
  const tlsRoutine = createToolLengthSetRoutine(settings, toolOffsets).join('\n');
  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';

  const gcode = `
    (Start of Tool Length Setter)
    ${preCmd}
    #<return_units> = [20 + #<_metric>]
    G21
    ${tlsRoutine}
    G53 G0 Z${settings.zSafe}
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

// === Clamp / unclamp sub-routines ===

function auxLineFor(settings, action) {
  const { on, off } = auxOnOff(settings.clampAuxOutput);
  // Fail-safe polarity: aux OFF (no power) holds the clamp; aux ON
  // releases it. So M6 uses M65 (or M9) to clamp and M64 (or M7/M8) to
  // release. If air / solenoid power is lost, the tool stays gripped.
  const cmd = action === 'clamp' ? off : on;
  return cmd || '(no clamp aux output configured)';
}

function slideFeedrate(settings) {
  return settings.slideSpeed > 0 ? settings.slideSpeed : 500;
}

function buildUnloadTool(settings, currentTool, slotPos) {
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

  // Cup: top-down drop. Center over the slot XY, descend to engagement Z,
  // release the clamp, retract. No horizontal slide.
  if (settings.rackHolding === 'Cup') {
    return `
      G53 G0 X${slotPos.engaged.x} Y${slotPos.engaged.y}
      G53 G0 Z${settings.slot1.z}
      G4 P0.5
      ${auxLineFor(settings, 'unclamp')}
      G4 P0.5
      G53 G0 Z${settings.zSafe}
      M61 Q0
    `.trim();
  }

  // Fork: approach → drop to engagement Z → slide into engaged → release
  // → retract Z. Tool stays in the fork fingers.
  const feed = slideFeedrate(settings);
  return `
    G53 G0 X${slotPos.approach.x} Y${slotPos.approach.y}
    G53 G0 Z${settings.slot1.z}
    G53 G1 X${slotPos.engaged.x} Y${slotPos.engaged.y} F${feed}
    G4 P0.5
    ${auxLineFor(settings, 'unclamp')}
    G4 P0.5
    G53 G0 Z${settings.zSafe}
    M61 Q0
  `.trim();
}

function buildLoadTool(settings, toolNumber, slotPos, tlsRoutine, drawbarAlreadyReleased = false) {
  if (toolNumber === 0) return '';

  if (toolNumber > settings.slots) {
    // Manual load. Dialog buttons depend on the drawbar state:
    //   - Just unloaded a rack tool or manual tool → drawbar is already
    //     released. Skip the Release step and use the CLAMP_TOOL dialog
    //     (single Clamp button, then Continue).
    //   - Coming from T0 (empty spindle at rest) → drawbar is clamped.
    //     Use the LOAD_TOOL dialog with Release + Clamp + Continue.
    if (drawbarAlreadyReleased) {
      return `
        G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
        G4 P0
        (MSG, PLUGIN_PNEUMATICATC:MANUAL_CLAMP_TOOL_${toolNumber})
        M0
        ${auxLineFor(settings, 'clamp')}
        M0
        M61 Q${toolNumber}
        ${tlsRoutine}
      `.trim();
    }
    return `
      G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
      G4 P0
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_LOAD_TOOL_${toolNumber})
      M0
      ${auxLineFor(settings, 'unclamp')}
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
      G4 P0.5`;

  // Cup: top-down pickup. Center over the tool sitting in the cup, descend
  // onto the shank, clamp, retract. No horizontal slide.
  if (settings.rackHolding === 'Cup') {
    return `
      G53 G0 X${slotPos.engaged.x} Y${slotPos.engaged.y}${releaseFirst}
      G53 G0 Z${settings.slot1.z}
      G4 P0.5
      ${auxLineFor(settings, 'clamp')}
      G4 P0.5
      G53 G0 Z${settings.zSafe}
      M61 Q${toolNumber}
      ${tlsRoutine}
    `.trim();
  }

  // Fork: descend onto the shank sitting in the fork, clamp, then slide
  // laterally out of the fork. Cannot slide into the fork with an empty
  // collet — must descend on the tool first.
  const feed = slideFeedrate(settings);
  return `
    G53 G0 X${slotPos.engaged.x} Y${slotPos.engaged.y}${releaseFirst}
    G53 G0 Z${settings.slot1.z}
    G4 P0.5
    ${auxLineFor(settings, 'clamp')}
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

function buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets = { x: 0, y: 0 }, storedTlo = 0) {
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
  const tlsRoutine = shouldProbe
    ? createToolLengthSetRoutine(settings, toolOffsets).join('\n')
    : (settings.tlsMode === 'library' && hasStoredTlo
        ? `(Load stored TLO from tool library)\n    G43.1 Z${storedTlo}`
        : '');

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
    : buildUnloadTool(settings, currentTool, sourceSlot);
  const loadSection = isManualToManual
    ? buildManualSwap(settings, toolNumber, tlsRoutine)
    : buildLoadTool(settings, toolNumber, targetSlot, tlsRoutine, drawbarAlreadyReleased);

  const preCmd = settings.preToolChangeGcode?.trim() || '';
  const postCmd = settings.postToolChangeGcode?.trim() || '';

  const gcode = `
    (Start of PneumaticATC Plugin Sequence)
    ${preCmd}
    #<return_units> = [20 + #<_metric>]
    G21
    M5
    G53 G0 Z${settings.zSafe}
    ${unloadSection}
    ${loadSection}
    G53 G0 Z${settings.zSafe}
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
  const program = createToolLengthSetProgram(settings, toolOffsets);
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

function handleHomeCommand(commands, context, settings) {
  const idx = commands.findIndex((c) => c.isOriginal && c.command.trim().toUpperCase() === '$H');
  if (idx === -1) return;
  if (!settings.performTlsAfterHome) return;

  const currentTool = context.machineState?.tool ?? 0;
  const toolOffsets = getToolOffsets(currentTool, context.tools);
  const tlsRoutine = createToolLengthSetRoutine(settings, toolOffsets).join('\n');
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
      G4 P0
      G53 G0 X0 Y0
      ${postCmd}
    o100 ENDIF
    G[#<return_units>]
  `.trim();
  const program = formatGCode(gcode);
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

function handleSlotCommand(commands, settings) {
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

  const base = calculateSlotBase(settings, slotNum);
  const gcode = `
    G53 G21 G90 G0 Z${settings.zSafe}
    G53 G21 G90 G0 X${base.x} Y${base.y}
  `.trim();
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
  const program = buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets, storedTlo);
  expandIntoCommands(commands, idx, commands[idx].command, program, settings);
}

// === Main entry point ===

function onBeforeCommand(commands, context, settings) {
  if (context && context.safeZHeight !== undefined) {
    settings.zSafe = context.safeZHeight;
  }
  handleHomeCommand(commands, context, settings);
  handleTLSCommand(commands, context, settings);
  handleSlotCommand(commands, settings);
  handleM6Command(commands, context, settings);
  return commands;
}

export { onBeforeCommand, buildInitialConfig };
