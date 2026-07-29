> ⚠️ **Beta — for testing only.** This is the first tagged release of the Pneumatic ATC plugin. The tool-change workflow is functional but the config surface (rack layout, TLS strategy, aux-output handling) is still evolving. Do not use on production jobs. Back up your `settings.json` before installing.

## What's Changed

### ✨ New Features
- Full pneumatic ATC tool change on `M6 Tn` — approach → engage → clamp → retract, with configurable Slide Direction, Slide Distance, Slide Speed, and Z-Retract
- Rack layout with two modes: **Linear array** (Slot 1 + Orientation + Direction + Slot Distance) and **Custom** (per-slot X/Y table). Switching to Custom offers to auto-populate the table from the Linear values
- Configurable slot count (1 – 8) plus a Manual Tool Position fallback when the requested tool is outside the rack
- Tool Length Setter integration with **Probe after every tool change** strategy (library-offset mode marked *coming soon*)
- Optional TLS after the first `$H` per session
- Positioning helpers: `$SLOT1` … `$SLOT8` jog the spindle over a slot's engaged position
- Pre / Post / Abort event hooks (Monaco G-code editors) for coolant, ATC covers, etc.
- Clamp / TLS aux output supports `M7`, `M8`, or numeric aux pins (`M64 P<n>`)
- Grab current button on every coord field so you can capture machine XY directly from the plugin dialog

### 🔧 Improvements
- Left-side navigation rail (Rack Setup / TLS / Manual / Events) matching the ncSender Settings dialog
- Fixed-height dialog so switching between sidebar entries doesn't resize the window
- Unsaved-changes guard on Close — offers Save & close, Discard, or Cancel
