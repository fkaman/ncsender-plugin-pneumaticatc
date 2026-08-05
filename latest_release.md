## What's Changed

### :bug: Bug Fixes
- **TLS return trip no longer routes to the far side** when the toolsetter and pre-M6 origin sit at the same workspace location beside the rack. The `tlsExit` "same side" test only compared perp edges — TLS and origin sharing a par-end (both past parMax or both past parMin) fell through to a corner detour that walked the machine out to the opposite side and back. The par-end pairs now short-circuit to a direct diagonal, matching the intent
