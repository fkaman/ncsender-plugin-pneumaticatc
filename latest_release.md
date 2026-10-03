## What's Changed

Pre-release based on siganberg's v0.1.48, with a retractable tool rack added. Not part of the upstream release.

### New Features
- Retractable tool rack. A Moving tool rack switch in the Advanced tab extends the rack before a change reaches a rack slot and retracts it afterwards. Two optional end-stop sensors confirm that the rack is out and that it is back. A miss stops the change with a Re-check dialog.
- Tool left in the spindle. A change that starts from an empty spindle now reads the tool sensor first and stops with a dialog if a tool is still seated, for example after a restart. Continue to open the drawbar and take it out by hand, or Abort, send M61 Q followed by the Tool ID, and run the change again so it is put back in its own slot.
- The new rack and tool-found dialogs are short plain text without buttons, so they show on the ncSender wireless pendant.

### Bug Fixes
- With taper blow on, the drawbar no longer closes before the spindle has lifted off the holder after an unload. It could pick the released tool straight back up.
