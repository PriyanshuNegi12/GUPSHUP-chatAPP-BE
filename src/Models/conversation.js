const mongoose = require('mongoose');
const { Schema } = mongoose;

const conversationSchema = new Schema({
    type:        { type: String, enum: ['direct', 'group'], required: true },
    name:        { type: String, trim: true, maxlength: 50 },   // only for groups
    avatar:      { type: String, default: null },               // CHANGED: only for groups (base64 data URL)
    createdBy:   { type: Schema.Types.ObjectId, ref: 'user', required: true },
    pairKey:     { type: String, unique: true, sparse: true },  // only for direct chats
    lastMessage: { type: Schema.Types.ObjectId, ref: 'message', default: null },
}, { timestamps: true });

const Conversation = mongoose.model('conversation', conversationSchema);

module.exports = Conversation;