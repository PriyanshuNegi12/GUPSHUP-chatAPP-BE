const loadAuthenticatedUser = require('./auth');

const userMiddleware = async (req, res, next) => {
    try {
        const { user, payload, token } = await loadAuthenticatedUser(req);
        req.result = user;
        req.tokenPayload = payload; // NEW: so logout/deleteProfile don't need to re-decode
        req.token = token;          // NEW: same reason
        next();
    } catch (err) {
        res.status(401).send("Error:  " + err);
    }
};

module.exports = userMiddleware;