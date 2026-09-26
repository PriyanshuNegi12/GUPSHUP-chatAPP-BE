const client = require('../Config/Redis');

const WINDOW_SECONDS = 15 * 60; // 15 minutes
const MAX_ATTEMPTS = 5;

// runs BEFORE login: blocks the request if either counter is already over the limit
const loginRateLimiter = async (req, res, next) => {
    try {
        const ip = req.ip;
        const identifier = typeof req.body.identifier === 'string'
            ? req.body.identifier.trim().toLowerCase()
            : '';

        const ipKey = `loginAttempts:ip:${ip}`;
        const idKey = identifier ? `loginAttempts:id:${identifier}` : null;

        const [ipCount, idCount] = await Promise.all([
            client.get(ipKey),
            idKey ? client.get(idKey) : null,
        ]);

        if (Number(ipCount) >= MAX_ATTEMPTS || Number(idCount) >= MAX_ATTEMPTS) {
            return res.status(429).json({ message: "Too many attempts. Try again later." });
        }

        req.rateLimitKeys = { ipKey, idKey }; // handed to the controller
        next();
    } catch (err) {
        next(); // if Redis is down, don't block login entirely
    }
};

// called by the controller on a failed login
const recordFailedLogin = async (keys) => {
    try {
        const { ipKey, idKey } = keys;
        await Promise.all([
            client.multi().incr(ipKey).expire(ipKey, WINDOW_SECONDS).exec(),
            idKey ? client.multi().incr(idKey).expire(idKey, WINDOW_SECONDS).exec() : null,
        ]);
    } catch (err) {
        console.error("rate limit record failed:", err);
    }
};

// called by the controller on a successful login
const clearLoginAttempts = async (keys) => {
    try {
        const { ipKey, idKey } = keys;
        await Promise.all([
            client.del(ipKey),
            idKey ? client.del(idKey) : null,
        ]);
    } catch (err) {
        console.error("rate limit clear failed:", err);
    }
};

module.exports = { loginRateLimiter, recordFailedLogin, clearLoginAttempts };