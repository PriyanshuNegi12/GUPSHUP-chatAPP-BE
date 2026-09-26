const mongoose = require('mongoose');
const { Schema } = mongoose;

const friendshipSchema = new Schema({
    requester: { type: Schema.Types.ObjectId, ref: 'user', required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'user', required: true },
    pairKey:   { type: String, required: true, unique: true },
    status:    { type: String, enum: ['pending', 'accepted', 'blocked'], default: 'pending' },
    blockedBy: { type: Schema.Types.ObjectId, ref: 'user', default: null },
}, { timestamps: true });

// fast lookups for "my friends" and "requests sent to me"
friendshipSchema.index({ requester: 1, status: 1 });
friendshipSchema.index({ recipient: 1, status: 1 });

const Friendship = mongoose.model('friendship', friendshipSchema);

module.exports = Friendship;