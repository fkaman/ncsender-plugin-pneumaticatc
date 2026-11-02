## What's Changed

Pre-release based on siganberg's v0.1.58, with a retractable tool rack added. Not part of the upstream release. Needs ncSender 2.0.221 or newer (Pro 2.0.304 or newer), like v0.1.58.

### New in this pre-release
- The rack and spindle-empty prompts now follow upstream's rule for a failed check: Re-check twice, then Abort only. The "Continue anyway" option is gone. To run without a check, clear its sensor pin in the settings.
- The spindle-empty check no longer repeats upstream's own check after a rack or probe unload. It still runs where upstream does not look: after the tool-found dialogs from an empty spindle, and after a manual unload where the operator took the tool out by hand.

### Also in this pre-release, compared with v0.1.58
- Retractable tool rack. A Moving tool rack switch in the Advanced tab extends the rack before a change reaches a rack slot and retracts it afterwards. Two optional end-stop sensors confirm that the rack is out and that it is back. A miss stops the change with a Re-check dialog.
- The spindle must be empty before anything is loaded, even when the tool was taken out by hand. A tool still in the spindle stops the change with a Spindle Not Empty dialog.
- Tool left in the spindle. A change that starts from an empty spindle reads the tool sensor first and stops with a dialog if a tool is still seated, for example after a restart. Continue to open the drawbar after the countdown and take it out by hand, or Abort, send M61 Q followed by the Tool ID, and run the change again so it is put back in its own slot.
- The new rack and tool dialogs are short plain text without buttons, so they show on the ncSender wireless pendant.
- The rack and these two tool checks work with wired inputs only. With the Wireless ATC profile they are left out and upstream's own checks run as usual.

### Bug Fixes
- With taper blow on, the drawbar no longer closes before the spindle has lifted off the holder after an unload. It could pick the released tool straight back up.

### Setup note
The tool sensor must read LOW with a tool in the spindle and HIGH when it is empty. If yours is wired the other way round, invert that input in grblHAL with $370.
