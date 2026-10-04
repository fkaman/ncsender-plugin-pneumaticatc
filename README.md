# Pneumatic ATC Plugin (Beta)

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project. If you choose to use it, you do so entirely at your own risk. I am not responsible for any damage, malfunction, or personal injury that may result from the use or misuse of this plugin. Use it with caution and at your own discretion.

Automatic tool changer support for pneumatic ATC systems that use a single aux output to clamp / unclamp the collet. The plugin intercepts `M6` and expands it into a full pick / drop sequence: park at the safe Z, slide the spindle into the fork holder, actuate the pneumatic clamp, and retract.

> **Beta** — the workflow is stable but the config surface (slot layout, TLS strategy) is still evolving. Back up your `settings.json` before adopting.

## Features

### Tool Change (M6)
- Intercepts `M6 Tn` (and `Tn M6`) and drives the spindle through: approach → engage → clamp toggle → retract
- Configurable slot count (1 – 8) with per-slot clamp state tracking
- Manual-tool fallback when the requested tool number is outside the rack
- Pre / Post / Abort event hooks let you toggle coolant, open ATC covers, etc.

### Rack Layout
- **Linear array** – uniform spacing driven by Slot 1 position + orientation (X/Y) + direction (±) + slot distance
- **Custom** – per-slot X/Y coordinates in a table, useful for multi-row racks or non-uniform spacing. Switching from Linear to Custom offers to auto-populate the table from the Linear values so you can start close and fine-tune

### Retractable Tool Rack
For a rack mounted on an actuator that extends it into position for a load/unload and retracts it clear of the machining area for the rest of the job.
- One aux output drives it (**ON extends, OFF retracts**), switched on with the **Moving tool rack** toggle in **Advanced**. With the toggle off the rack is never driven and the pins are ignored (but remembered).
- The rack is extended once, before the first motion toward a rack slot, and retracted once after the whole change, including the toolsetter trip, Post Tool Change and the final leg back to where the change started. A rack-to-rack swap does not retract between the unload and the load; a manual-to-manual or probe-holder change never touches the rack.
- Both moves first go to Z-safe and wait for the planner to stop (`G4 P0`), so the rack never moves while the spindle is still travelling up.
- Two optional end-stop inputs confirm each end of travel: **Rack Available** after extending, **Rack Unavailable** after retracting. They are separate sensors, not one read both ways, so a rack stuck mid-travel is caught. Both read **OK when HIGH** (invert the port with `$370` if yours reads the other way). A miss pauses the job with a Re-check / Abort dialog; after two re-checks the dialog says plainly that continuing is unverified.
- `$SLOT1` … `$SLOT8` extend the rack but never retract it, since you jogged there on purpose. `$TLS` and Measure All Tools extend before the probe and retract after.
- Nothing changes for machines that don't use it: with no rack configured, the generated programs are identical to a stock install.

### Tool Found In The Spindle
After a restart the controller boots as T0 even if a tool was left in the collet. When a **Tool Sensor** pin is set (Advanced), every tool change that starts from T0 first reads it, before the rack extends or anything moves. If it reports a tool (LOW = present), the change stops with a **Tool Found In Spindle** dialog:
- **Continue** parks at the manual station (routed around the rack). Hold the tool, then **Continue** again opens the drawbar; a second dialog asks you to take the tool out, and **Continue** carries on from an empty spindle.
- **Abort**, then send `M61 Q<n>` (the tool's Tool ID) in the terminal and run the change again: the tool is unloaded into its own slot. The plugin can't tell which tool it is, so only do this if you're certain of the number; a wrong one puts it into a slot that may already be occupied.

The drawbar opens only after the dialog **Countdown** (5 seconds unless changed in the plugin's dialog settings), so be holding the tool by then or it will fall.

**The spindle must be empty before anything is loaded.** With a Tool Sensor pin set, every change that loads a tool reads the sensor again right before the spindle moves to pick it up, after any unload and after the dialogs above. A tool still in the spindle stops the change with a **Spindle Not Empty** dialog; **Re-check** reads the sensor again and only carries on once it reads empty. After two re-checks the last dialog says plainly that carrying on may crash into the rack. Upstream's own check after an unload only warns once, and Continue carries on regardless; this one does not let go until the sensor agrees. A manual-to-manual swap is not gated, since the old tool is meant to be there.

The sensor must read LOW with a tool present and HIGH when the spindle is empty. If it is wired the other way round, invert that input in grblHAL (`$370`); otherwise none of these checks will see a tool.

With no Tool Sensor pin set nothing is checked.

The dialogs this plugin adds (tool found, rack faults) are plain text of at most 96 characters with no custom buttons, so they fit and show on the wireless pendant. Upstream's longer messages and the four manual-tool dialogs (which have buttons) are unchanged.

### Tool Length Setter (TLS)
- **Probe after every tool change** – always runs TLS on `M6`
- **Use tool library offset (probe when missing)** – reuses the stored TLO from the tool library; probes only when a tool has no offset yet, then writes the value back so subsequent swaps skip the probe
- Optional automatic TLS after the first `$H` (per-session first-home)
- Configurable seek distance, seek feedrate, and TLS aux output for the probe signal

### Aux Output Support
- Clamp / unclamp control via `M7`, `M8`, or a numeric `M64 P<n>` / `M65 P<n>` pin
- Same options for the TLS probe signal

### Positioning Commands
- `$SLOT1` … `$SLOT8` – jog the spindle over a slot's engaged position (at Z-safe)

### Safety
- Halts and prompts the operator when a load / unload sequence needs manual intervention (out-of-rack tool)
- Grabs the current machine XY into any coordinate field so you don't hand-copy values

## Configuration

Open **Plugins → Pneumatic ATC** from the toolbar. The dialog uses a left-side navigation rail mirroring the ncSender Settings dialog.

### Rack Setup
| Section | Setting | Notes |
|---------|---------|-------|
| **Size and Holding** | Number of Slots | 1 – 8 |
| | Clamp Aux Output | `M7` / `M8` / numeric aux pin |
| | Rack Holding | `Fork` (Cup coming soon) |
| **Layout** | Layout mode | `Linear array` or `Custom` |
| | Slot 1 X/Y/Z + Grab | Engaged position of Slot 1 (Z = spindle descent depth) |
| | Orientation / Direction / Slot Distance | Linear mode only |
| | Per-slot table | Custom mode only (X/Y, Engagement Z shared) |
| **Engage Motion** | Slide Direction | ± along the axis perpendicular to Orientation |
| | Slide Distance / Speed | Horizontal travel to enter / leave the fork |
| | Z-Retract | Post-engage clearance |
| **Options** | Show G-Code Commands on Terminal | Reveals the expanded macro output |

### TLS
| Setting | Notes |
|---------|-------|
| TLS Strategy | `Probe after every tool change` (default) or `Use tool library offset (probe when missing)` |
| Tool Setter Location + Grab | Machine XY of the touch plate |
| Seek Distance / Feedrate | Probe motion parameters |
| TLS Aux Output | Optional signal to enable the probe |
| Perform TLS after first `$H` | Run TLS once per session after the first home |

### Advanced → Retractable Tool Rack
| Setting | Notes |
|---------|-------|
| Moving tool rack | Master switch. Off = the rack is never driven; the pins below are kept |
| Tool Rack Aux Output | `M7` / `M8` / numeric aux pin. ON extends, OFF retracts. Required when the switch is on |
| Rack Available Sensor | Optional aux input; must read HIGH after the rack extends |
| Rack Unavailable Sensor | Optional aux input; must read HIGH after the rack retracts |

### Manual
Machine XY where the spindle parks and prompts the operator when the requested tool number is outside the rack.

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
| `$SLOT1` … `$SLOT8` | Move the spindle to a slot's XY at Z-safe |
| `$H` | Home; optionally followed by a TLS routine (see toggle above) |

## Typical Setup

1. **Wire the clamp** to an aux output that you can drive with either `M7/M8` (mist/flood) or a numeric pin (`M64 P<n>`). Confirm the output actuates the collet fixture reliably.
2. **Set the rack** by jogging the spindle to Slot 1's fully-engaged position and hitting **Grab** — this captures machine XY plus the descent Z. Configure Orientation / Direction / Slot Distance to match your rack (Linear mode) or switch to Custom for irregular racks.
3. **Set the TLS location** by touching off a known tool on the setter, then Grab. Pick your strategy — probe every time is safest until you trust the library offsets.
4. **Save**. The plugin registers `M6`, `$TLS`, `$SLOT1..N` handlers and updates ncSender's tool count to match your slot count.

## Installation

Install through the ncSender **Plugins** interface (Add plugin from URL or `.zip`).

## Development

Plugin source lives alongside the other ncSender plugins:
https://github.com/siganberg/ncsender-plugin-pneumaticatc

Main ncSender project: https://github.com/siganberg/ncSender
