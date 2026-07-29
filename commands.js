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

    seekDistance: toFiniteNumber(raw.seekDistance, 50),
    seekFeedrate: toFiniteNumber(raw.seekFeedrate, 500),

    preToolChangeGcode: raw.preToolChangeGcode ?? '',
    postToolChangeGcode: raw.postToolChangeGcode ?? '',
    abortEventGcode: raw.abortEventGcode ?? '',

    tlsAuxOutput: sanitizeAuxOutput(raw.tlsAuxOutput),
    clampAuxOutput: sanitizeAuxOutput(raw.clampAuxOutput)
  };
};

// === Tool offset lookup ===

function getToolOffsets(toolNumber, tools) {
  if (!toolNumber || toolNumber <= 0 || !Array.isArray(tools)) {
    return { x: 0, y: 0, z: 0 };
  }
  const tool = tools.find((t) => t.toolNumber === toolNumber);
  if (tool && tool.offsets) {
    return { x: tool.offsets.x || 0, y: tool.offsets.y || 0, z: tool.offsets.tlsZ || 0 };
  }
  return { x: 0, y: 0, z: 0 };
}

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
  const tlsZ = toolOffsets.z || 0;

  const extraZMove = tlsZ !== 0 ? `G91 G0 Z${tlsZ}\n    G90` : '';

  const { on: tlsOn, off: tlsOff } = auxOnOff(settings.tlsAuxOutput);
  const auxOn = tlsOn ? `G4 P0\n    ${tlsOn}\n    G4 P0` : '';
  const auxOff = tlsOff ? `G4 P0\n    ${tlsOff}\n    G4 P0` : '';

  const gcode = `
    G53 G0 Z${settings.zSafe}
    G53 G0 X${tlsX} Y${tlsY}
    ${extraZMove}
    ${auxOn}
    G43.1 Z0
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G4 P0.2
    G38.4 G91 Z5 F75
    G91 G0 Z5
    G90
    ${auxOff}
    #<_ofs_idx> = [#5220 * 20 + 5203]
    #<_cur_wcs_z_ofs> = #[#<_ofs_idx>]
    #<_nc_last_tlo> = [#5063 + #<_cur_wcs_z_ofs>]
    G43.1 Z[#<_nc_last_tlo>]
    (Notify ncSender that toolLengthSet is now set)
    $#=_tool_offset
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
  const cmd = action === 'clamp' ? on : off;
  return cmd || '(no clamp aux output configured)';
}

function slideFeedrate(settings) {
  return settings.slideSpeed > 0 ? settings.slideSpeed : 500;
}

function buildUnloadTool(settings, currentTool, slotPos) {
  if (currentTool === 0) return '';

  if (currentTool > settings.slots) {
    return `
      G53 G0 Z${settings.zSafe}
      G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
      G4 P0
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_UNLOAD_TOOL_${currentTool})
      M0
      M61 Q0
    `.trim();
  }

  // Approach → drop to engagement Z → slide into engaged position → release
  // → retract Z. Tool stays in the fork.
  const feed = slideFeedrate(settings);
  return `
    G53 G0 Z${settings.zSafe}
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

function buildLoadTool(settings, toolNumber, slotPos, tlsRoutine) {
  if (toolNumber === 0) return '';

  if (toolNumber > settings.slots) {
    return `
      G53 G0 Z${settings.zSafe}
      G53 G0 X${settings.manualTool.x} Y${settings.manualTool.y}
      G4 P0
      (MSG, PLUGIN_PNEUMATICATC:MANUAL_LOAD_TOOL_${toolNumber})
      M0
      M61 Q${toolNumber}
      ${tlsRoutine}
    `.trim();
  }

  // Top-down pick: descend onto the shank sitting in the fork, clamp, then
  // slide laterally out of the fork. Cannot slide into the fork with an
  // empty collet — must descend on the tool first.
  const feed = slideFeedrate(settings);
  return `
    G53 G0 Z${settings.zSafe}
    G53 G0 X${slotPos.engaged.x} Y${slotPos.engaged.y}
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

function buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets = { x: 0, y: 0 }) {
  const sourceSlot = calculateSlotPosition(settings, currentTool);
  const targetSlot = calculateSlotPosition(settings, toolNumber);
  // Probing decision:
  //   'always' — probe on every M6.
  //   'library' — probe only when the tool has no TLO in the library yet
  //               (heuristic: |tlsZ| < 0.0001). Once probed, ncSender's
  //               `$#=_tool_offset` writes the value back into the tool
  //               table, so subsequent swaps of the same tool skip probing.
  const hasStoredTlo = Math.abs(toolOffsets.z || 0) > 0.0001;
  const shouldProbe = settings.tlsMode === 'always'
    || (settings.tlsMode === 'library' && !hasStoredTlo);
  const tlsRoutine = shouldProbe
    ? createToolLengthSetRoutine(settings, toolOffsets).join('\n')
    : '';

  const unloadSection = buildUnloadTool(settings, currentTool, sourceSlot);
  const loadSection = buildLoadTool(settings, toolNumber, targetSlot, tlsRoutine);

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
  const toolOffsets = getToolOffsets(currentTool, context.tools);
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
  const toolOffsets = getToolOffsets(toolNumber, context.tools);
  const program = buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets);
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
