const Member = require('../Models/member');
const Conversation = require('../Models/conversation');
const Message = require('../Models/message');
const Friendship = require('../Models/friendship');
const client = require('../Config/Redis');

const formatMessage = (m) => ({
    _id: m._id,
    conversation: m.conversation,
    sender: m.sender,
    type: m.type,
    text: m.deletedAt ? null : m.text,
    deleted: !!m.deletedAt,
    createdAt: m.createdAt,
});

const httpError = (status, message) => {
    const err = new Error(message);
    err.status = status;
    return err;
};

async function sendMessage(io, { me, conversationId, text }) {
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText || cleanText.length > 2000) {
        throw httpError(400, "Message must be 1 to 2000 characters");
    }

    const [isMember, conversation] = await Promise.all([
        Member.exists({ conversation: conversationId, user: me }),
        Conversation.findById(conversationId).select('type pairKey').lean(),
    ]);
    if (!isMember || !conversation) throw httpError(404, "Chat not found");

    if (conversation.type === 'direct') {
        const isFriend = await Friendship.exists({ pairKey: conversation.pairKey, status: 'accepted' });
        if (!isFriend) throw httpError(403, "You can't send messages in this chat");
    }

    const message = await Message.create({ conversation: conversationId, sender: me, text: cleanText });
    await Conversation.updateOne({ _id: conversationId }, { lastMessage: message._id });

    const payload = formatMessage(message);

    // broadcast to everyone currently viewing this specific chat
    io.to(String(conversationId)).emit("newMessage", payload);

    // NEW: notify every member's personal room too, so the chat list updates
    // live even for members who don't have this chat open right now
    // (different page, different window/tab). The message itself is already
    // saved in MongoDB, so opening the chat later always shows it.
    const allMembers = await Member.find({ conversation: conversationId }).select('user').lean();
    allMembers.forEach((m) => {
        io.to(String(m.user)).emit("chat:updated", {
            conversationId: String(conversationId),
            lastMessage: payload,
        });
    });

    // mark delivered for whoever is online right now
    const others = allMembers.filter((m) => String(m.user) !== String(me));
    const onlineFlags = await Promise.all(
        others.map(async (m) => ({ user: String(m.user), online: (await client.sCard(`online:${m.user}`)) > 0 }))
    );
    const deliveredTo = onlineFlags.filter((f) => f.online).map((f) => f.user);

    if (deliveredTo.length) {
        await Member.updateMany(
            { conversation: conversationId, user: { $in: deliveredTo } },
            { lastDeliveredAt: message.createdAt }
        );
        deliveredTo.forEach((userId) => {
            io.to(String(conversationId)).emit("delivered", {
                conversationId: String(conversationId),
                userId,
                deliveredAt: message.createdAt,
            });
        });
    }

    return payload;
}

async function deleteMessage(io, { me, messageId }) {
    const message = await Message.findOneAndUpdate(
        { _id: messageId, sender: me, deletedAt: null },
        { deletedAt: new Date() },
        { returnDocument: 'after' }
    ).lean();

    if (!message) throw httpError(404, "Message not found");

    io.to(String(message.conversation)).emit("messageDeleted", {
        _id: message._id,
        conversation: message.conversation,
    });

    return formatMessage(message);
}

async function markRead(io, { me, conversationId }) {
    const now = new Date();
    const result = await Member.updateOne(
        { conversation: conversationId, user: me },
        { lastReadAt: now, lastDeliveredAt: now }
    );
    if (!result.matchedCount) throw httpError(404, "Chat not found");

    io.to(String(conversationId)).emit("messagesRead", {
        conversationId: String(conversationId), userId: String(me), readAt: now,
    });

    const latestMessage = await Message.findOne({ conversation: conversationId, deletedAt: null })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean();

    if (latestMessage) {
        const allMembers = await Member.find({ conversation: conversationId })
            .select('lastReadAt').lean();
        const allRead = allMembers.every((m) => m.lastReadAt && m.lastReadAt >= latestMessage.createdAt);
        if (allRead) {
            io.to(String(conversationId)).emit("readByAll", {
                conversationId: String(conversationId), upTo: latestMessage.createdAt,
            });
        }
    }

    return { lastReadAt: now };
}

module.exports = { sendMessage, deleteMessage, markRead, formatMessage };