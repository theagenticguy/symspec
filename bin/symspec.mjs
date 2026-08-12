#!/usr/bin/env node
// The published bin. A thin wrapper over the single-file bundle so the shebang
// and the executable bit live in a stable path that never changes as the build
// output does.
import './../dist/cli.mjs'
