const mongoose = require('mongoose');
const { Schema } = mongoose;

const memberSchema = new Schema({
    conversation:    { type: Schema.Types.ObjectId, ref: 'conversation', required: true },
    user:            { type: Schema.Types.ObjectId, ref: 'user', required: true },
    role:            { type: String, enum: ['creator', 'member'], default: 'member' },
    lastDeliveredAt: { type: Date, default: null },
    lastReadAt:      { type: Date, default: null },
}, { timestamps: true });

// one person can be in one chat only once
memberSchema.index({ conversation: 1, user: 1 }, { unique: true });

// fast "show all my chats"
memberSchema.index({ user: 1 });

const Member = mongoose.model('member', memberSchema);

module.exports = Member;