const User = require('../Models/user');

const isId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
const PUBLIC_ADMIN_FIELDS = 'username firstname lastname emailId role isActive avatar createdAt lastSeenAt';

const listUsers = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
        const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

        const filter = q
            ? { $or: [{ username_lower: { $regex: q } }, { emailId: { $regex: q } }] }
            : {};

        const [users, total] = await Promise.all([
            User.find(filter)
                .select(PUBLIC_ADMIN_FIELDS)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            User.countDocuments(filter),
        ]);

        res.status(200).json({ users, total, page, limit });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

// soft-delete: same pattern as the user's own deleteProfile — keeps
// existing messages/friendships/conversations pointing at a valid
// (just deactivated) user instead of a dangling reference
const deleteUserByAdmin = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isId(userId)) return res.status(400).json({ message: "Invalid user" });

        if (String(userId) === String(req.result._id))
            return res.status(400).json({ message: "You can't remove your own account from here" });

        const user = await User.findById(userId).select('isActive');
        if (!user) return res.status(404).json({ message: "User not found" });
        if (!user.isActive) return res.status(400).json({ message: "User is already removed" });

        user.isActive = false;
        await user.save();

        res.status(200).json({ message: "User removed" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = { listUsers, deleteUserByAdmin };