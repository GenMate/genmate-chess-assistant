// Entry point for `node --test tests/`: Node 22 runs the directory as a module
// (this file), which loads every *.test.js here. Newer Node versions that
// expand the directory themselves pick up the *.test.js files directly.
'use strict';
const fs = require('fs');
const path = require('path');
for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}
