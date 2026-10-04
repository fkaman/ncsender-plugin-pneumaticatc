## What's Changed

Pre-release based on siganberg's v0.1.48, with a retractable tool rack added. Not part of the upstream release.

### New in this pre-release
- The spindle must be empty before anything is loaded. With a Tool Sensor pin set, every change that loads a tool reads the sensor again right before the spindle moves to pick it up. A tool still in the spindle stops the change with a Spindle Not Empty dialog. Re-check reads the sensor again and only carries on once it reads empty. Upstream's own check after an unload only warns once and lets Continue carry on.

### Also in this pre-release, compared with v0.1.48
- Retractable tool rack. A Moving tool rack switch in the Advanced tab extends the rack before a change reaches a rack slot and retracts it afterwards. Two optional end-stop sensors confirm that the rack is out and that it is back. A miss stops the change with a Re-check dialog.
- Tool left in the spindle. A change that starts from an empty spindle reads the tool sensor first and stops with a dialog if a tool is still seated, for example after a restart. Continue to open the drawbar after the countdown and take it out by hand, or Abort, send M61 Q followed by the Tool ID, and run the change again so it is put back in its own slot.
- The new rack and tool dialogs are short plain text without buttons, so they show on the ncSender wireless pendant.

### Bug Fixes
- With taper blow on, the drawbar no longer closes before the spindle has lifted off the holder after an unload. It could pick the released tool straight back up.

### Setup note
The tool sensor must read LOW with a tool in the spindle and HIGH when it is empty. If yours is wired the other way round, invert that input in grblHAL with $370.
