## What's Changed

### :rocket: New Features
- **Rack routing rewrite** — every entry / exit now pivots on the slot's **entrance** (slot XY + safety margin on the loading side). Cleaner three-case ladder based on where origin sits relative to the outer keepout:
  - Past the sliding-side edge → direct diagonal
  - Off the sliding side, par past the rack → entry-side corner detour
  - Off the sliding side, par inside the rack range → opposite-side corner detour (perp cross at par-end)
- **Chained tool swap fast path** — Tm→Tn now walks straight from slot M to slot N at Z-safe (spindle is above the tools), no exit-and-re-enter detour
- **TLS routing** — same routing model applied to the toolsetter leg: `tlsEntrance` gets the machine from the slot approach to TLS around the keepout, and `tlsExit` returns to origin with the corner detour when TLS and origin sit on opposite sides of the rack
- **Regression test suite** — `commands.test.js` locks the emitted G-code shape for every routing case (24 tests via `node --test`) so future edits can't silently regress a working path

### :wrench: Improvements
- Renamed **Keepout Padding** → **Safety Margin** for clarity
- Rack Holding: **Cup** option temporarily disabled and labeled *(coming soon)* — Fork mode is the tested path for now
- **Safety Margin** field is separate from Slide Distance so the visualizer keepout envelope can be larger than the physical slide-off travel
- Advanced Settings keepout auto-publish clamps the rectangle to your machine's travel limits ($130 / $131 + home location) so it never spills off the bed
- Default **Slot Distance** bumped from 45 mm → 60 mm for the 80 mm spindles common on ATC-equipped machines
