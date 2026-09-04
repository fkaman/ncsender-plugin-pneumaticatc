# Pneumatic ATC Plugin (Beta)

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project. If you choose to use it, you do so entirely at your own risk. I am not responsible for any damage, malfunction, or personal injury that may result from the use or misuse of this plugin. Use it with caution and at your own discretion.

This plugin is an adaptation of the original Pneumatic ATC plugin to support a HQD or equivalent pneumatic ATC spindle system.

Automatic tool changer support for pneumatic ATC systems that use a single aux output to clamp / unclamp the collet. The plugin intercepts `M6` and expands it into a full pick / drop sequence: park at the safe Z, enter the rack slot, actuate the pneumatic clamp, verify (if sensors are wired), probe tool length (if configured), and retract.

> **Beta** — the workflow is stable but the config surface is still evolving. Back up your `settings.json` before adopting.

## Features

### Tool Change (M6)
- Intercepts `M6 Tn` (and `Tn M6`) and drives the spindle through: approach → engage → clamp toggle → verify → retract
- Configurable slot count (1 – 32) with per-slot clamp state tracking
- Two rack holding styles: **Fork** (side-entry, slide-in/out) and **Cup** (drop-in, no slide)
- Manual-tool fallback when the requested tool number is outside the rack
- If a rack tool's clamp doesn't confirm seated (Tool Seated Sensor configured), the sequence automatically falls back to a manual-load dialog for the same tool number instead of aborting the job
- Guards against a stale "spindle believed empty" software state at startup (e.g. after a reboot with a tool still physically loaded)
- Pre / Post / Abort event hooks let you toggle coolant, open ATC covers, etc.
- Optional **Taper Blow / Cone Clean**: closes the drawbar right after lifting off an unloaded holder instead of leaving it open for the whole traverse to the next slot, for kits where the taper-blow air port is teed off the drawbar valve. The settle dwell before re-clamping is configurable per install

### Rack Layout
- **Linear array** – uniform spacing driven by Slot 1 position + orientation (X/Y) + direction (±) + slot distance
- **Custom** – per-slot X/Y coordinates in a table, useful for multi-row racks or non-uniform spacing. Switching from Linear to Custom offers to auto-populate the table from the Linear values so you can start close and fine-tune
- **Sienci ATC profile** – one-click preset that locks pin assignments and rack geometry to Sienci's published kit values (also switches Taper Blow on)

### Tool Length Setter (TLS)
- **Probe after every tool change** – always runs TLS on `M6`
- **Use tool library offset (probe when missing)** – reuses the stored TLO from the tool library; probes only when a tool has no offset yet, then writes the value back so subsequent swaps skip the probe
- **Measure All Tools** – one action on the TLS tab that loads every tool with a rack slot in turn, probes each on the tool setter regardless of what's stored, saves the length to the library, then returns to where you started
- Optional automatic TLS after the first `$H` (per-session first-home)
- Configurable seek start Z, seek distance, seek feedrate, and TLS aux output for the probe signal

### Units
- Metric or Imperial display, with a sidebar badge showing which is active. Values are always stored in mm internally

### Aux Output Support
- Clamp / unclamp control via `M7`, `M8`, or a numeric `M64 P<n>` / `M65 P<n>` pin
- Same options for the TLS probe signal

### Positioning Commands
- `$SLOT1` … `$SLOT<n>` – jog the spindle over a slot's engaged position (at Z-safe)

### Safety
- **Air Pressure Sensor** – checked once, before the tool change starts, matching Sienci's own macro convention. A fault pauses the job with a Re-check / Abort dialog
- **Drawbar Released Sensor** – verified right after the collet unclamps
- **Tool Seated Sensor** – verified right after the collet clamps; also gates the automatic fallback to manual load described above
- All three sensors are independently optional (skip any input you haven't wired) and read via grblHAL aux inputs — invert polarity with the controller's own `$370` port-invert mask, not a plugin toggle
- Any Release action that opens the drawbar (manual unload, manual swap, or an automatic-load fallback) dwells for a configurable countdown before actually releasing, giving the operator time to clear the spindle
- Halts and prompts the operator when a load / unload sequence needs manual intervention
- Grabs the current machine XY into any coordinate field so you don't hand-copy values

## Configuration

Open **Plugins → Pneumatic ATC** from the toolbar. The dialog uses a left-side navigation rail mirroring the ncSender Settings dialog.

### Rack Setup
| Section | Setting | Notes |
|---------|---------|-------|
| **Size and Holding** | Number of Slots | 1 – 32 |
| | Clamp Aux Output | `M7` / `M8` / numeric aux pin |
| | Rack Holding | `Fork` or `Cup` |
| | ATC Profile | `Generic` or `Sienci` (locks pins + geometry + Taper Blow) |
| **Layout** | Layout mode | `Linear array` or `Custom` |
| | Slot 1 X/Y/Z + Grab | Engaged position of Slot 1 (Z = spindle descent depth) |
| | Orientation / Direction / Slot Distance | Linear mode only |
| | Per-slot table | Custom mode only |
| **Engage Motion** | Slide Direction | ± along the axis perpendicular to Orientation (Fork only) |
| | Slide Distance / Speed | Horizontal travel to enter / leave the fork (Fork only) |
| | Z-Retract | Post-engage clearance |
| **Sensors** | Air Pressure / Drawbar / Tool Seated | grblHAL aux inputs, each optional |
| **Taper Blow** | Taper Blow / Cone Clean | On/off — forced on and locked under the Sienci profile |
| | Release Settle (s) | Dwell before re-clamping after the unload lift — editable even under the Sienci profile |
| **Options** | Show G-Code Commands on Terminal | Reveals the expanded macro output |
| | Release Countdown | Seconds a Release action dwells before the drawbar actually opens |

### TLS
| Setting | Notes |
|---------|-------|
| TLS Strategy | `Probe after every tool change` (default) or `Use tool library offset (probe when missing)` |
| Measure All Tools | Batch-probes every rack tool and saves lengths to the library (library strategy only) |
| Tool Setter Location + Grab | Machine XY of the touch plate |
| Seek Start Z / Distance / Feedrate | Probe motion parameters |
| TLS Aux Output | Optional signal to enable the probe |
| Perform TLS after first `$H` | Run TLS once per session after the first home |

### Manual
Machine XY where the spindle parks and prompts the operator when the requested tool number is outside the rack, or when a rack tool's clamp doesn't confirm seated.

### Events
Three Monaco G-code editors:
- **Pre Tool Change** – runs before every `M6`
- **Post Tool Change** – runs after every `M6`
- **Abort Event** – runs when the tool change is aborted

## Commands

| Command | Effect |
|---------|--------|
| `M6 Tn` | Full tool change to slot n (or manual position if `n > slots`) |
| `$TLS` | Standalone tool-length probe at the configured setter position |
| `$MEASURE_TLO Tn` | One step of the Measure All Tools batch — probes tool n and saves it (driven by the TLS tab's UI, not typically issued by hand) |
| `$SLOT1` … `$SLOT<n>` | Move the spindle to a slot's XY at Z-safe |
| `$H` | Home; optionally followed by a TLS routine (see toggle above) |

## Typical Setup

1. **Wire the clamp** to an aux output that you can drive with either `M7/M8` or a numeric pin (`M64 P<n>`). Confirm the output actuates the collet fixture reliably.
2. **Pick a profile** — select `Sienci` if you're on that kit to auto-fill pins and geometry, otherwise stay on `Generic` (this covers HQD and other equivalent pneumatic ATC spindles).
3. **Set the rack** by jogging the spindle to Slot 1's fully-engaged position and hitting **Grab** — this captures machine XY plus the descent Z. Configure Orientation / Direction / Slot Distance to match your rack (Linear mode) or switch to Custom for irregular racks.
4. **Wire any sensors** you have (Air Pressure, Drawbar Released, Tool Seated) — each is optional and independently configurable; invert polarity in firmware (`$370`) if needed rather than in the plugin.
5. **Set the TLS location** by touching off a known tool on the setter, then Grab. Pick your strategy — probe every time is safest until you trust the library offsets, then switch to library mode and use Measure All Tools to seed it.
6. **Save**. The plugin registers `M6`, `$TLS`, `$MEASURE_TLO`, `$SLOT1..N` handlers and updates ncSender's tool count to match your slot count.

## Installation

Install through the ncSender **Plugins** interface (Add plugin from URL or `.zip`).

## Development

This is a fork of the original Pneumatic ATC plugin, adapted to support a HQD or equivalent pneumatic ATC spindle system, and tracking upstream while adding safety sensors, the manual-fallback recovery path, taper blow, and Measure All Tools:
https://github.com/fkaman/ncsender-plugin-pneumaticatc

Upstream: https://github.com/siganberg/ncsender-plugin-pneumaticatc

Main ncSender project: https://github.com/siganberg/ncSender
