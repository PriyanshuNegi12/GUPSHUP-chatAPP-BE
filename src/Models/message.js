const mongoose = require('mongoose');
const { Schema } = mongoose;

const messageSchema = new Schema({
    conversation: { type: Schema.Types.ObjectId, ref: 'conversation', required: true },
    sender:       { type: Schema.Types.ObjectId, ref: 'user', required: true },
    type:         { type: String, enum: ['text'], default: 'text' },
    text:         { type: String, trim: true, maxlength: 2000 },
    deletedAt:    { type: Date, default: null },
}, { timestamps: true });

// load one chat's messages, newest first, fast
messageSchema.index({ conversation: 1, createdAt: -1 });

const Message = mongoose.model('message', messageSchema);

module.exports = Message;