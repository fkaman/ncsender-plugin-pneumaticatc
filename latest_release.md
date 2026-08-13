## What's Changed

### 🔧 Improvements
- **Sienci ATC profile** now locks the full kit geometry — rack layout, orientation, direction, slot spacing, holder style, number of slots (restricted to 6 and 12), slide direction / distance / speed, safety margin, and drawbar wiring — all read-only against Sienci's fixed values.
- **Import positions dialog** always opens when selecting the Sienci profile, so builds without the setup-macro coordinates can still preview the flow. New per-row status dots, cleaner labels, accent-colored values, and a footer summary line indicate what will and won't be imported.
- **Skip / Discard buttons** are now solid red for clearer decline affordance.
- **Sidebar tab label** shortened to "ATC Setup" so it fits without ellipsis (the panel heading stays "ATC/Rack Setup").
- **"Not on this board" warning** is suppressed on the Sienci profile — a Sienci-labelled build shouldn't nag about pins the profile expects.

### 🧹 Cleanup
- **Removed the redundant profile info banners** on Rack Setup and Advanced tabs — the top-of-card help text plus the dashed-border read-only styling already convey what those banners repeated.
- **Removed the unused Z-Retract setting** — it was in the UI but never read by the tool-change program.
- **Drawbar Offset / Feedrate inputs removed** — fixed at 1 mm / 300 mm/min. Compensation applies to both Cup and Fork racks.
