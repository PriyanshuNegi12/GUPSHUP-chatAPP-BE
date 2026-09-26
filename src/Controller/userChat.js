const User = require('../Models/user');
const Friendship = require('../Models/friendship');
const Conversation = require('../Models/conversation');
const Member = require('../Models/member');
const Message = require('../Models/message');
const chatService = require('../Services/chatService');
const { formatMessage } = chatService;

const PUBLIC = 'username firstname avatar';
const MAX_GROUP_SIZE = 50;
const PAGE_SIZE = 30;

const isId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
const getPairKey = (a, b) => [String(a), String(b)].sort().join('_');

// CHANGED: now respects err.status (set by chatService) instead of always
// returning 500 — required so sendMessage/deleteMessage/markRead keep their
// original 400/403/404 status codes after delegating to the shared service.
const fail = (res, err) => {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: "Something went wrong" });
};

const cleanIds = (ids, me) => {
    if (!Array.isArray(ids) || !ids.every(isId)) return null;
    const set = new Set(ids.map((i) => i.toLowerCase()));
    set.delete(String(me));
    return [...set];
};

const allAreMyFriends = async (me, ids) => {
    const [activeCount, friendCount] = await Promise.all([
        User.countDocuments({ _id: { $in: ids }, isActive: true }),
        Friendship.countDocuments({
            pairKey: { $in: ids.map((id) => getPairKey(me, id)) },
            status: 'accepted',
        }),
    ]);
    return activeCount === ids.length && friendCount === ids.length;
};

// 1. Open (or create) a direct chat with a friend — unchanged
const openDirectChat = async (req, res) => {
    try {
        const { userId } = req.params;
        const me = req.result._id;
        if (!isId(userId)) return res.status(400).json({ message: "Invalid user" });

        const other = await User.findById(userId).select(`${PUBLIC} isActive`).lean();
        if (!other || !other.isActive) return res.status(404).json({ message: "User not found" });
        if (String(other._id) === String(me))
            return res.status(400).json({ message: "Invalid user" });

        const pairKey = getPairKey(me, other._id);

        const isFriend = await Friendship.exists({ pairKey, status: 'accepted' });
        if (!isFriend) return res.status(403).json({ message: "You can only chat with friends" });

        let conversation = await Conversation.findOne({ pairKey }).select('_id type').lean();

        if (!conversation) {
            try {
                conversation = await Conversation.create({ type: 'direct', createdBy: me, pairKey });
            } catch (err) {
                if (err.code !== 11000) throw err;
                conversation = await Conversation.findOne({ pairKey }).select('_id type').lean();
            }

            await Member.bulkWrite([me, other._id].map((user) => ({
                updateOne: {
                    filter: { conversation: conversation._id, user },
                    update: { $setOnInsert: { role: 'member' } },
                    upsert: true,
                },
            })));
        }

        res.status(200).json({
            conversation: { _id: conversation._id, type: conversation.type },
            user: { _id: other._id, username: other.username, firstname: other.firstname, avatar: other.avatar },
        });
    } catch (err) {
        fail(res, err);
    }
};

// 2. Home screen: all my chats — unchanged
const getChatList = async (req, res) => {
    try {
        const me = req.result._id;

        const memberships = await Member.find({ user: me }).select('conversation lastReadAt').lean();
        if (!memberships.length) return res.status(200).json({ chats: [] });

        const readAt = new Map(memberships.map((m) => [String(m.conversation), m.lastReadAt]));

        const conversations = await Conversation.find({ _id: { $in: memberships.map((m) => m.conversation) } })
            .sort({ updatedAt: -1 })
            .limit(50)
            .populate({ path: 'lastMessage', select: 'conversation sender type text deletedAt createdAt' })
            .lean();

        const direct = conversations.filter((c) => c.type === 'direct');

        const [others, friendships, unread] = await Promise.all([
            direct.length
                ? Member.find({ conversation: { $in: direct.map((c) => c._id) }, user: { $ne: me } })
                    .select('conversation user')
                    .populate('user', PUBLIC)
                    .lean()
                : [],
            direct.length
                ? Friendship.find({ pairKey: { $in: direct.map((c) => c.pairKey) }, status: 'accepted' })
                    .select('pairKey')
                    .lean()
                : [],
            Promise.all(conversations.map((c) => {
                const last = readAt.get(String(c._id));
                return Message.countDocuments(
                    {
                        conversation: c._id,
                        sender: { $ne: me },
                        deletedAt: null,
                        ...(last && { createdAt: { $gt: last } }),
                    },
                    { limit: 99 }
                );
            })),
        ]);

        const otherByChat = new Map(others.map((o) => [String(o.conversation), o.user]));
        const friendKeys = new Set(friendships.map((f) => f.pairKey));

        const chats = conversations.map((c, i) => ({
            _id: c._id,
            type: c.type,
            name: c.type === 'group' ? c.name : undefined,
            user: c.type === 'direct' ? (otherByChat.get(String(c._id)) ?? null) : undefined,
            canSend: c.type === 'group' || friendKeys.has(c.pairKey),
            lastMessage: c.lastMessage ? formatMessage(c.lastMessage) : null,
            unread: unread[i],
            updatedAt: c.updatedAt,
        }));

        res.status(200).json({ chats });
    } catch (err) {
        fail(res, err);
    }
};

// 7. Create a group
const createGroup = async (req, res) => {
    let conversation;
    try {
        const me = req.result._id;
        const { name, memberIds } = req.body;

        if (typeof name !== 'string' || !name.trim() || name.trim().length > 50)
            return res.status(400).json({ message: "Group name must be 1 to 50 characters" });

        const ids = cleanIds(memberIds, me);
        if (!ids || ids.length < 1 || ids.length > MAX_GROUP_SIZE - 1)
            return res.status(400).json({ message: `Add 1 to ${MAX_GROUP_SIZE - 1} valid members` });

        if (!await allAreMyFriends(me, ids))
            return res.status(403).json({ message: "You can only add your friends" });

        conversation = await Conversation.create({ type: 'group', name: name.trim(), createdBy: me });

        const now = new Date();
        await Member.insertMany([
            { conversation: conversation._id, user: me, role: 'creator', lastReadAt: now, lastDeliveredAt: now },
            ...ids.map((user) => ({
                conversation: conversation._id, user, role: 'member', lastReadAt: now, lastDeliveredAt: now,
            })),
        ]);

        // NEW / optional: lets added members see the group appear live.
        // Delete these two lines if you don't want it — response body below is unchanged either way.
        const io = req.app.get('io');
        ids.forEach((userId) => io.to(userId).emit('chat:new', { conversation: { _id: conversation._id, type: 'group', name: conversation.name } }));

        res.status(201).json({
            conversation: { _id: conversation._id, type: 'group', name: conversation.name },
            message: "Group created",
        });
    } catch (err) {
        if (conversation) await Conversation.deleteOne({ _id: conversation._id }).catch(() => {});
        fail(res, err);
    }
};

// 8. Add friends to a group (creator only)
const addGroupMembers = async (req, res) => {
    try {
        const me = req.result._id;
        const { conversationId } = req.params;
        if (!isId(conversationId)) return res.status(400).json({ message: "Invalid chat" });

        const ids = cleanIds(req.body.memberIds, me);
        if (!ids || ids.length < 1 || ids.length > MAX_GROUP_SIZE - 1)
            return res.status(400).json({ message: "Add valid members" });

        const [isCreator, group] = await Promise.all([
            Member.exists({ conversation: conversationId, user: me, role: 'creator' }),
            Conversation.findOne({ _id: conversationId, type: 'group' }).select('name').lean(),
        ]);
        if (!isCreator || !group)
            return res.status(403).json({ message: "Only the group creator can add members" });

        if (!await allAreMyFriends(me, ids))
            return res.status(403).json({ message: "You can only add your friends" });

        const size = await Member.countDocuments({ conversation: conversationId });
        if (size + ids.length > MAX_GROUP_SIZE)
            return res.status(400).json({ message: `A group can have at most ${MAX_GROUP_SIZE} members` });

        const now = new Date();
        const result = await Member.bulkWrite(ids.map((user) => ({
            updateOne: {
                filter: { conversation: conversationId, user },
                update: { $setOnInsert: { role: 'member', lastReadAt: now, lastDeliveredAt: now } },
                upsert: true,
            },
        })));

        // NEW / optional real-time notifications — delete if unwanted
        const io = req.app.get('io');
        const summary = { _id: conversationId, type: 'group', name: group.name };
        ids.forEach((userId) => io.to(userId).emit('chat:new', { conversation: summary }));
        io.to(conversationId).emit('group:membersAdded', { conversationId, userIds: ids });

        res.status(200).json({ added: result.upsertedCount, message: "Members added" });
    } catch (err) {
        fail(res, err);
    }
};

// 5. Delete my own message — now delegates to chatService, response shape unchanged
const deleteMessage = async (req, res) => {
    try {
        const { messageId } = req.params;
        if (!isId(messageId)) return res.status(400).json({ message: "Invalid message" });

        const io = req.app.get('io');
        const result = await chatService.deleteMessage(io, { me: req.result._id, messageId });
        res.status(200).json({ message: result });
    } catch (err) {
        fail(res, err);
    }
};

// 3. Message history — unchanged
const getMessages = async (req, res) => {
    try {
        const me = req.result._id;
        const { conversationId } = req.params;
        if (!isId(conversationId)) return res.status(400).json({ message: "Invalid chat" });

        let before = null;
        if (req.query.before !== undefined) {
            before = typeof req.query.before === 'string' ? new Date(req.query.before) : new Date(NaN);
            if (isNaN(before)) return res.status(400).json({ message: "Invalid date" });
        }

        const isMember = await Member.exists({ conversation: conversationId, user: me });
        if (!isMember) return res.status(404).json({ message: "Chat not found" });

        const [messages, progress] = await Promise.all([
            Message.find({ conversation: conversationId, ...(before && { createdAt: { $lt: before } }) })
                .sort({ createdAt: -1 })
                .limit(PAGE_SIZE)
                .lean(),
            before
                ? null
                : Member.find({ conversation: conversationId, user: { $ne: me } })
                    .select('user lastDeliveredAt lastReadAt')
                    .lean(),
        ]);

        res.status(200).json({
            messages: messages.map(formatMessage),
            hasMore: messages.length === PAGE_SIZE,
            ...(progress && { progress }),
        });
    } catch (err) {
        fail(res, err);
    }
};

// 4. Send a text message — now delegates to chatService, response shape unchanged
const sendMessage = async (req, res) => {
    try {
        const me = req.result._id;
        const { conversationId } = req.params;
        if (!isId(conversationId)) return res.status(400).json({ message: "Invalid chat" });

        const io = req.app.get('io');
        const payload = await chatService.sendMessage(io, { me, conversationId, text: req.body.text });
        res.status(201).json({ message: payload });
    } catch (err) {
        fail(res, err);
    }
};

// 6. Mark the chat as read — now delegates to chatService, response shape unchanged
const markRead = async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!isId(conversationId)) return res.status(400).json({ message: "Invalid chat" });

        const io = req.app.get('io');
        const result = await chatService.markRead(io, { me: req.result._id, conversationId });
        res.status(200).json(result);
    } catch (err) {
        fail(res, err);
    }
};

// 9. Who is in this chat — unchanged
const getMembers = async (req, res) => {
    try {
        const me = req.result._id;
        const { conversationId } = req.params;
        if (!isId(conversationId)) return res.status(400).json({ message: "Invalid chat" });

        const rows = await Member.find({ conversation: conversationId })
            .select('user role')
            .populate('user', PUBLIC)
            .lean();

        if (!rows.some((r) => String(r.user?._id) === String(me)))
            return res.status(404).json({ message: "Chat not found" });

        res.status(200).json({
            members: rows.filter((r) => r.user).map((r) => ({ user: r.user, role: r.role })),
        });
    } catch (err) {
        fail(res, err);
    }
};

// Leave a group
const leaveGroup = async (req, res) => {
    try {
        const me = req.result._id;
        const { conversationId } = req.params;
        if (!isId(conversationId)) return res.status(400).json({ message: "Invalid chat" });

        const conversation = await Conversation.findOne({ _id: conversationId, type: 'group' }).select('_id').lean();
        if (!conversation) return res.status(404).json({ message: "Group not found" });

        const myMembership = await Member.findOneAndDelete({ conversation: conversationId, user: me });
        if (!myMembership) return res.status(404).json({ message: "You are not in this group" });

        // NEW / optional
        const io = req.app.get('io');
        io.to(conversationId).emit('group:memberLeft', { conversationId, userId: String(me) });

        const remaining = await Member.find({ conversation: conversationId }).sort({ createdAt: 1 }).limit(1);

        if (remaining.length === 0) {
            await Promise.all([
                Conversation.deleteOne({ _id: conversationId }),
                Message.deleteMany({ conversation: conversationId }),
            ]);
        } else if (myMembership.role === 'creator') {
            await Member.updateOne({ _id: remaining[0]._id }, { role: 'creator' });
            io.to(conversationId).emit('group:newCreator', { conversationId, userId: String(remaining[0].user) }); // NEW / optional
        }

        res.status(200).json({ message: "Left the group" });
    } catch (err) {
        fail(res, err);
    }
};

// Remove a member (creator only)
const removeMember = async (req, res) => {
    try {
        const me = req.result._id;
        const { conversationId, userId } = req.params;
        if (!isId(conversationId) || !isId(userId)) return res.status(400).json({ message: "Invalid request" });

        if (userId.toLowerCase() === String(me).toLowerCase())
            return res.status(400).json({ message: "Use leave group instead" });

        const [isCreator, isGroup] = await Promise.all([
            Member.exists({ conversation: conversationId, user: me, role: 'creator' }),
            Conversation.exists({ _id: conversationId, type: 'group' }),
        ]);
        if (!isCreator || !isGroup)
            return res.status(403).json({ message: "Only the group creator can remove members" });

        const removed = await Member.findOneAndDelete({ conversation: conversationId, user: userId });
        if (!removed) return res.status(404).json({ message: "Member not found" });

        // NEW / optional
        const io = req.app.get('io');
        io.to(conversationId).emit('group:memberRemoved', { conversationId, userId });
        io.to(userId).emit('group:removedFrom', { conversationId });

        res.status(200).json({ message: "Member removed" });
    } catch (err) {
        fail(res, err);
    }
};

module.exports = {
    openDirectChat, getChatList, createGroup, addGroupMembers,
    deleteMessage, getMessages, sendMessage, markRead, getMembers, leaveGroup, removeMember,
};