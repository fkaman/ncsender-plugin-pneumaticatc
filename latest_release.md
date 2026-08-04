## What's Changed

### :wrench: Improvements
- Pro / Community edition awareness — the plugin now asks the core which edition it is running on and only wires up Pro-specific features when the core supports them:
  - Rack routing gcode: `$keepout_off` bypass prefix is only added on Pro so the plugin can route tools inside the keepout zone; on Community the token is omitted since Community does not have keepout enforcement
  - Advanced Settings keepout auto-publish: only fires when the core reports itself as Pro
