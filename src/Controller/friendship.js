const mongoose = require('mongoose');
const User = require('../Models/user');
const Friendship = require('../Models/friendship');

const getPairKey = (a, b) => [String(a), String(b)].sort().join('_');
const PUBLIC = 'username firstname avatar';

const sendFriendRequest = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        const io = req.app.get('io');

        if (!mongoose.isValidObjectId(userId))
            return res.status(400).json({ message: "Invalid user" });

        const user = await User.findById(userId).select('_id isActive');
        if (!user || !user.isActive)
            return res.status(404).json({ message: "User not found" });

        if (String(user._id) === String(me))
            return res.status(400).json({ message: "You can't send a request to yourself" });

        const pairKey = getPairKey(me, user._id);

        const tryAutoAccept = () => Friendship.findOneAndUpdate(
            { pairKey, status: 'pending', requester: user._id, recipient: me },
            { status: 'accepted' },
            { returnDocument: 'after' }
        );

        let accepted = await tryAutoAccept();
        if (accepted) {
            io.to(String(user._id)).emit('friend:accepted', { userId: String(me) });
            io.to(String(me)).emit('friend:accepted', { userId: String(user._id) });
            return res.status(200).json({
                friendship: { _id: accepted._id, status: accepted.status },
                message: "You are now friends"
            });
        }

        try {
            const friendship = await Friendship.create({
                requester: me,
                recipient: user._id,
                pairKey,
                status: 'pending'
            });

            io.to(String(user._id)).emit('friend:requestReceived', { userId: String(me) });

            return res.status(201).json({
                friendship: { _id: friendship._id, status: friendship.status },
                message: "Friend Request Sent Successfully"
            });
        } catch (err) {
            if (err.code !== 11000) throw err;

            accepted = await tryAutoAccept();
            if (accepted) {
                io.to(String(user._id)).emit('friend:accepted', { userId: String(me) });
                io.to(String(me)).emit('friend:accepted', { userId: String(user._id) });
                return res.status(200).json({
                    friendship: { _id: accepted._id, status: accepted.status },
                    message: "You are now friends"
                });
            }
            return res.status(409).json({ message: "Cannot send request" });
        }
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const acceptFriendRequest = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        const io = req.app.get('io');

        if (!mongoose.isValidObjectId(userId))
            return res.status(400).json({ message: "Invalid user" });

        if (String(me) === userId)
            return res.status(400).json({ message: "Invalid request" });

        const pairKey = getPairKey(me, userId);

        const friendship = await Friendship.findOneAndUpdate(
            { pairKey, status: 'pending', requester: userId, recipient: me },
            { status: 'accepted' },
            { returnDocument: 'after' }
        );

        if (!friendship)
            return res.status(404).json({ message: "Friend request not found" });

        io.to(userId).emit('friend:accepted', { userId: String(me) });
        io.to(String(me)).emit('friend:accepted', { userId });

        res.status(200).json({
            friendship: { _id: friendship._id, status: friendship.status },
            message: "Friend request accepted"
        });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const rejectFriendRequest = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        const io = req.app.get('io');

        if (!mongoose.isValidObjectId(userId) || String(me) === userId)
            return res.status(400).json({ message: "Invalid user" });

        const deleted = await Friendship.findOneAndDelete({
            pairKey: getPairKey(me, userId),
            status: 'pending',
            requester: userId,
            recipient: me
        });
        if (!deleted) return res.status(404).json({ message: "Friend request not found" });

        io.to(userId).emit('friend:rejected', { userId: String(me) });

        res.status(200).json({ message: "Friend request rejected" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const cancelFriendRequest = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        const io = req.app.get('io');

        if (!mongoose.isValidObjectId(userId) || String(me) === userId)
            return res.status(400).json({ message: "Invalid user" });

        const deleted = await Friendship.findOneAndDelete({
            pairKey: getPairKey(me, userId),
            status: 'pending',
            requester: me,
            recipient: userId
        });
        if (!deleted) return res.status(404).json({ message: "Friend request not found" });

        io.to(userId).emit('friend:cancelled', { userId: String(me) });

        res.status(200).json({ message: "Friend request cancelled" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const unfriend = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        const io = req.app.get('io');

        if (!mongoose.isValidObjectId(userId) || String(me) === userId)
            return res.status(400).json({ message: "Invalid user" });

        const deleted = await Friendship.findOneAndDelete({
            pairKey: getPairKey(me, userId),
            status: 'accepted'
        });
        if (!deleted) return res.status(404).json({ message: "Friend not found" });

        io.to(userId).emit('friend:removed', { userId: String(me) });

        res.status(200).json({ message: "Friend removed" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const blockFriend = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        const io = req.app.get('io');

        if (!mongoose.isValidObjectId(userId))
            return res.status(400).json({ message: "Invalid user" });

        const user = await User.findById(userId).select('_id');
        if (!user) return res.status(404).json({ message: "User not found" });

        if (String(user._id) === String(me))
            return res.status(400).json({ message: "Invalid user" });

        const pairKey = getPairKey(me, user._id);

        const tryBlock = () => Friendship.findOneAndUpdate(
            { pairKey, status: { $ne: 'blocked' } },
            { status: 'blocked', blockedBy: me },
            { returnDocument: 'after' }
        );

        let doc = await tryBlock();

        if (!doc) {
            const existing = await Friendship.findOne({ pairKey }).select('_id');
            if (!existing) {
                try {
                    await Friendship.create({
                        requester: me,
                        recipient: user._id,
                        pairKey,
                        status: 'blocked',
                        blockedBy: me
                    });
                } catch (err) {
                    if (err.code !== 11000) throw err;
                    await tryBlock();
                }
            }
        }

        io.to(String(user._id)).emit('friend:removed', { userId: String(me) }); // they lose you either way

        res.status(200).json({ message: "User blocked" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const unblockFriend = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;

        if (!mongoose.isValidObjectId(userId) || String(me) === userId)
            return res.status(400).json({ message: "Invalid user" });

        const deleted = await Friendship.findOneAndDelete({
            pairKey: getPairKey(me, userId),
            status: 'blocked',
            blockedBy: me
        });
        if (!deleted) return res.status(404).json({ message: "Blocked user not found" });

        res.status(200).json({ message: "User unblocked" });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const getAllFriends = async (req, res) => {
    try {
        const me = req.result._id;
        const docs = await Friendship.find({
            status: 'accepted',
            $or: [{ requester: me }, { recipient: me }]
        })
            .populate({ path: 'requester', select: PUBLIC, match: { isActive: true } })
            .populate({ path: 'recipient', select: PUBLIC, match: { isActive: true } })
            .sort({ updatedAt: -1 });

        const friends = docs
            .filter(d => d.requester && d.recipient)
            .map(d => String(d.requester._id) === String(me) ? d.recipient : d.requester);

        res.status(200).json({ friends });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const getAllReceivedRequests = async (req, res) => {
    try {
        const docs = await Friendship.find({ status: 'pending', recipient: req.result._id })
            .populate({ path: 'requester', select: PUBLIC, match: { isActive: true } })
            .sort({ createdAt: -1 });

        const requests = docs
            .filter(d => d.requester)
            .map(d => ({ user: d.requester, sentAt: d.createdAt }));
        res.status(200).json({ requests });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const getAllSentRequests = async (req, res) => {
    try {
        const docs = await Friendship.find({ status: 'pending', requester: req.result._id })
            .populate({ path: 'recipient', select: PUBLIC, match: { isActive: true } })
            .sort({ createdAt: -1 });

        const requests = docs
            .filter(d => d.recipient)
            .map(d => ({ user: d.recipient, sentAt: d.createdAt }));
        res.status(200).json({ requests });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

const getAllBlocked = async (req, res) => {
    try {
        const me = req.result._id;
        const docs = await Friendship.find({ status: 'blocked', blockedBy: me })
            .populate({ path: 'requester', select: PUBLIC })
            .populate({ path: 'recipient', select: PUBLIC });

        const blocked = docs
            .filter(d => d.requester && d.recipient)
            .map(d => String(d.requester._id) === String(me) ? d.recipient : d.requester);
        res.status(200).json({ blocked });
    } catch (err) {
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = {
    sendFriendRequest, acceptFriendRequest, rejectFriendRequest, cancelFriendRequest,
    unfriend, blockFriend, unblockFriend,
    getAllFriends, getAllReceivedRequests, getAllSentRequests, getAllBlocked
};