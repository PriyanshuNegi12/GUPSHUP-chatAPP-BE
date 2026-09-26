const validate = require("../Utils/validate");
const client = require('../Config/Redis');
const User = require("../Models/user");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { validateOTP, generateOTP } = require("../Utils/gmailOTP");
const { recordFailedLogin, clearLoginAttempts } = require('../Middleware/rateLimiter');
const Friendship = require("../Models/friendship");
const { authCookieOptions, clearCookieOptions } = require('../Utils/cookieOptions');

// Shared by userRegister and adminRegister — both do the same
// "no OTP -> send one" / "OTP present -> verify + create" flow.
async function registerWithOTP({ emailId, username, otp, firstname, password, role }) {
    if (!otp) {
        const exists = await User.exists({
            $or: [{ emailId }, { username_lower: username.toLowerCase() }]
        });
        if (exists) {
            const err = new Error("Email or username already taken");
            err.status = 409;
            throw err;
        }
        await generateOTP({ emailId });
        return { otpSent: true };
    }

    if (!await validateOTP({ emailId, otp })) {
        throw new Error("Invalid OTP");
    }

    const user = await User.create({
        username,
        username_lower: username.toLowerCase(),
        emailId,
        firstname,
        password: await bcrypt.hash(password, 10),
        role,
    });

    return { user };
}

const userRegister = async (req, res) => {
    try {
        validate(req.body);

        const emailId = req.body.emailId.trim().toLowerCase();
        const username = req.body.username.trim();

        const result = await registerWithOTP({
            emailId, username, otp: req.body.otp,
            firstname: req.body.firstname.trim(),
            password: req.body.password,
            role: 'user',
        });

        if (result.otpSent) return res.status(200).json({ message: "OTP sent to your email" });

        const { user } = result;

        const token = jwt.sign(
            { _id: user._id, username: user.username, role: user.role },
            process.env.JWT_KEY,
            { expiresIn: 60 * 60 }
        );

        const reply = {
            firstname: user.firstname,
            emailId: user.emailId,
            username: user.username,
            _id: user._id,
            role: user.role
        };

        res.cookie('token', token, authCookieOptions(60 * 60 * 1000));

        res.status(201).json({
            user: reply,
            message: "Registered Successfully"
        });

    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: "Email or username already taken" });
        res.status(err.status || 400).json({ message: err.message });
    }
};

const adminRegister = async (req, res) => {
    try {
        validate(req.body);

        const emailId = req.body.emailId.trim().toLowerCase();
        const username = req.body.username.trim();
        const role = ['user', 'admin'].includes(req.body.role) ? req.body.role : 'user';

        const result = await registerWithOTP({
            emailId, username, otp: req.body.otp,
            firstname: req.body.firstname.trim(),
            password: req.body.password,
            role,
        });

        if (result.otpSent) return res.status(200).json({ message: "OTP sent to your email" });

        res.status(201).send("User Registered Successfully");
    } catch (err) {
        if (err.code === 11000 || err.status === 409) return res.status(409).send("Email or username already taken");
        res.status(err.status || 400).send("Error: " + err.message);
    }
};

const checkAvailability = async (req, res) => {
    try {
        const username = typeof req.query.username === 'string' ? req.query.username.trim().toLowerCase() : null;
        const emailId = typeof req.query.emailId === 'string' ? req.query.emailId.trim().toLowerCase() : null;

        const result = {};
        if (username) {
            if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
                result.username = { available: false, reason: "Invalid format" };
            } else {
                const taken = await User.exists({ username_lower: username });
                result.username = { available: !taken };
            }
        }
        if (emailId) {
            const taken = await User.exists({ emailId });
            result.emailId = { available: !taken };
        }

        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const searchUsers = async (req, res) => {
    try {
        const q = req.query.q;
        if (typeof q !== 'string')
            return res.status(400).json({ message: "Invalid search" });

        const prefix = q.trim().toLowerCase();
        if (prefix.length < 3 || prefix.length > 20 || !/^[a-z0-9_]+$/.test(prefix))
            return res.status(400).json({ message: "Enter 3 to 20 letters, numbers or underscore" });

        const me = req.result._id;

        const blocks = await Friendship.find({
            status: 'blocked',
            blockedBy: { $ne: me },
            $or: [{ requester: me }, { recipient: me }]
        }).select('blockedBy');
        const hidden = blocks.map(b => b.blockedBy);

        const users = await User.find({
            username_lower: { $regex: '^' + prefix },
            _id: { $nin: [me, ...hidden] },
            isActive: true
        })
            .select('username firstname avatar')
            .sort({ username_lower: 1 })
            .limit(10);

        res.status(200).json({ users });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const userLogin = async (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier || !password) {
            await recordFailedLogin(req.rateLimitKeys);
            throw new Error("Invalid Credentials");
        }

        const id = identifier.trim().toLowerCase();
        const query = id.includes('@') ? { emailId: id } : { username_lower: id };

        const user = await User.findOne(query).select('+password');
        if (!user || !user.isActive) {
            await recordFailedLogin(req.rateLimitKeys);
            throw new Error("Invalid Credentials");
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            await recordFailedLogin(req.rateLimitKeys);
            throw new Error("Invalid Credentials");
        }

        await clearLoginAttempts(req.rateLimitKeys);

        const reply = {
            firstname: user.firstname,
            username: user.username,
            emailId: user.emailId,
            _id: user._id,
            role: user.role
        };
        const token = jwt.sign({ _id: user._id, role: user.role, username: user.username }, process.env.JWT_KEY, { expiresIn: 60 * 60 });
        res.cookie('token', token, authCookieOptions(60 * 60 * 1000));
        res.status(200).json({
            user: reply,
            message: "Login Successfully"
        });

    } catch (err) {
        res.status(401).send("Error: " + err);
    }
};

const userLogout = async (req, res) => {
    try {
        const { token, tokenPayload } = req; // set by userMiddleware — no need to decode again
        await client.set(`token:${token}`, 'blocked');
        await client.expireAt(`token:${token}`, tokenPayload.exp);
        res.cookie("token", "", clearCookieOptions());
        res.send("Logged Out Successfull");

    } catch (err) {
        res.status(401).send("Error:  " + err);
    }
};

const deleteProfile = async (req, res) => {
    try {
        const userId = req.result._id;

        await User.findByIdAndUpdate(userId, { isActive: false });

        const { token, tokenPayload } = req;
        const ttl = tokenPayload.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) await client.set(`token:${token}`, 'blocked', { EX: ttl });

        res.cookie("token", "", clearCookieOptions());

        res.status(200).json({ message: "Account deleted" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = { userRegister, userLogin, userLogout, adminRegister, deleteProfile, checkAvailability, searchUsers };