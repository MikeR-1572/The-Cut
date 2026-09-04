'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §2): registry mapping a `profile` string
 * ('draw' | 'holdem' | 'stud') to its declarative table. A table with no
 * profile selected yet (or, in principle, a future profile that never
 * adopts the phase-machine pattern) has no entry here -- `getProfileTable`
 * returns `undefined` for those, and every call site is written to treat
 * a missing table as "not phase-gated, nothing to look up" rather than
 * throwing, matching how those tables already behaved pre-8.0.
 *
 * Adding a fourth phase-machine profile is "add its table here" --
 * exactly the data-authoring task ARCHITECTURE_v8.md §2/§5 describes,
 * as opposed to writing new bespoke rail-render/banner/transition
 * functions that hopefully match the existing ones' conventions by eye.
 */

const draw = require('./draw');
const holdem = require('./holdem');
const stud = require('./stud');

const PROFILE_TABLES = { draw, holdem, stud };

function getProfileTable(profile) {
  return PROFILE_TABLES[profile];
}

/** Convenience: true only for a profile with a real, registered table AND `capabilities.phaseGated`. Never throws for an unknown/null profile. */
function isPhaseGated(profile) {
  return getProfileTable(profile)?.capabilities?.phaseGated === true;
}

module.exports = { PROFILE_TABLES, getProfileTable, isPhaseGated };
