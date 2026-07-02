const crypto = require('node:crypto');

// Purely cosmetic identity for account holders (e.g. "frenzy horse"),
// replacing self-reported free text on friend connections — see the
// account-name override in routes/connections.js's serialize(). No
// uniqueness enforced across accounts: ~50x50 = 2500 combinations is
// plenty for a personal-scale relay, and a duplicate is harmless (it's
// not a login credential, just a display label).
const ADJECTIVES = [
  'frenzy', 'clever', 'brave', 'quiet', 'swift', 'lucky', 'mighty', 'gentle',
  'wild', 'bold', 'calm', 'eager', 'fuzzy', 'jolly', 'keen', 'lively',
  'merry', 'nimble', 'proud', 'quick', 'royal', 'sunny', 'tidy', 'vivid',
  'witty', 'zesty', 'amber', 'coral', 'dusky', 'faint', 'giant', 'hasty',
  'icy', 'jagged', 'kind', 'loud', 'misty', 'noble', 'odd', 'plucky',
  'rusty', 'salty', 'tame', 'upbeat', 'velvet', 'warm', 'young', 'zany',
  'breezy', 'crisp',
];
const NOUNS = [
  'horse', 'fox', 'wolf', 'eagle', 'tiger', 'panda', 'otter', 'falcon',
  'bear', 'hawk', 'owl', 'lynx', 'raven', 'moose', 'heron', 'badger',
  'beetle', 'cobra', 'dolphin', 'ferret', 'gecko', 'ibis', 'jackal',
  'koala', 'lemur', 'magpie', 'newt', 'ocelot', 'puma', 'quail', 'rabbit',
  'seal', 'toucan', 'urchin', 'viper', 'walrus', 'yak', 'zebra', 'antelope',
  'bison', 'cougar', 'dingo', 'egret', 'finch', 'gazelle', 'ibex',
  'jaguar', 'kite',
];

function randomDisplayName() {
  const adjective = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  return `${adjective} ${noun}`;
}

module.exports = { randomDisplayName };
