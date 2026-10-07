#!/usr/bin/env node
// A stand-in for $EDITOR: keeps what it was given in $FAKE_EDITOR_SEEN, writes $FAKE_EDITOR_TEXT over the file
// when set, and exits with $FAKE_EDITOR_EXIT (default 0), as if the user had edited and quit.

import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
writeFileSync(process.env.FAKE_EDITOR_SEEN, readFileSync(file, "utf8"));
if (process.env.FAKE_EDITOR_TEXT !== undefined) writeFileSync(file, process.env.FAKE_EDITOR_TEXT);
process.exit(Number(process.env.FAKE_EDITOR_EXIT ?? 0));
