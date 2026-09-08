'use strict';

/**
 * NEW 8.0 (ARCHITECTURE_v8.md §10, sequencing item 1): runs every split
 * test file in one process, in the same order the original monolithic
 * `engine.test.js` ran them in, so `npm test`'s output and pass/fail
 * behavior are unchanged from the person's perspective -- one combined
 * "ok"/"FAIL" stream, `process.exitCode` set to 1 by `test()` itself
 * (in test/helpers.js) the moment any assertion throws, same mechanism
 * as before, now just shared correctly across module boundaries since
 * `require()` caches each split file's module instance for the life of
 * this one process.
 *
 * Order here matches dependency order, not just the original file's
 * order: deck (no dependencies) -> player/actionDispatch (the two new
 * modules this refactor introduced, tested standalone) -> gameTable-core
 * (the shared lobby/chips/betting/claim mechanisms every profile builds
 * on) -> the three profile-specific suites.
 */

require('./deck.test');
require('./player.test');
require('./actionDispatch.test');
require('./gameTable-core.test');
require('./profiles/draw.test');
require('./profiles/holdem.test');
require('./profiles/holdem-9-0.test');
require('./profiles/holdem-9-1.test');
require('./profiles/stud.test');
require('./profiles/betting-extension-9-4.test');
require('./profiles/betting-limits-9-5.test');
require('./profiles/betting-9-6.test');
require('./profiles/betting-9-7.test');
require('./gameTable-10-0.test');
require('./gameTable-10-1.test');
require('./gameTable-10-2.test');
require('./gameTable-10-3.test');
require('./gameTable-10-4.test');
require('./gameTable-11-0.test');
require('./gameTable-11-1.test');
require('./gameTable-11-2.test');
require('./gameTable-11-3.test');

console.log('\nDone.');
