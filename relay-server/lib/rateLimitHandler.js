// express-rate-limit's default handler replies with plain text ("Too many
// requests, please try again later.") — every client error path unconditionally
// calls res.json() on a non-2xx response, so a rate limit hit surfaced as a raw
// "Unexpected token 'T' ... is not valid JSON" parse error instead of a readable
// message. One shared JSON handler for every limiter fixes it at the source.
module.exports = function rateLimitHandler(req, res) {
  res.status(429).json({ error: 'Too many requests — wait a moment and try again.' });
};
