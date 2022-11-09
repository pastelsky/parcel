#! /usr/bin/env node
// @flow strict-local
/* eslint-disable no-console */

// $FlowFixMe[untyped-import]
require('@parcel/babel-register');

const unlink = require('../src/unlink').default;
const {parseArgs, printUsage} = require('../src/util');

let exitCode = 0;

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  printUsage(console.error);
  exitCode = 1;
}

if (args?.help) {
  printUsage();
  exitCode = 0;
} else if (args) {
  try {
    if (args.dryRun) console.log('Dry run...');
    unlink({appRoot: process.cwd(), dryRun: args.dryRun, log: console.log});
    console.log('🎉 unlinking successful');
  } catch (e) {
    console.error(e.message);
    exitCode = 1;
  }
}

process.exit(exitCode);
